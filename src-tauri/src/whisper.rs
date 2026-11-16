//! Speech-to-text back-ends. shdw prefers ffmpeg's `whisper` filter; when the installed ffmpeg
//! was built without it (stock Homebrew), it falls back to whisper.cpp's `whisper-cli`.
//! Both consume the same pinned ggml models and must return JSON lines `{start,end,text}`
//! with times in milliseconds, which is what the editor's transcript parser expects.

use serde_json::Value;
use std::path::Path;

/// Does `ffmpeg -filters` output list a filter named exactly `whisper`?
pub fn filters_include_whisper(filters_output: &str) -> bool {
    // lines look like ` ... whisper           A->A       Transcribe audio using whisper.cpp.`
    filters_output.lines().any(|l| {
        let mut tok = l.split_whitespace();
        matches!((tok.next(), tok.next()), (Some(flags), Some("whisper")) if flags.len() == 3)
    })
}

/// Accept `auto` or a 2-3 letter lowercase language code; anything else could smuggle options
/// into the ffmpeg filter string or the whisper-cli command line.
pub fn validate_language(lang: &str) -> Result<String, String> {
    let code_like = (2..=3).contains(&lang.len()) && lang.bytes().all(|b| b.is_ascii_lowercase());
    if lang == "auto" || code_like {
        Ok(lang.to_string())
    } else {
        Err(format!("invalid language code {lang:?} (use `auto` or a code like `en`)"))
    }
}

/// Arguments for `whisper-cli` that transcribe a 16 kHz mono WAV into `<out_prefix>.json`.
pub fn cli_args(model: &Path, wav: &Path, out_prefix: &Path, language: &str) -> Vec<String> {
    let p = |x: &Path| x.to_string_lossy().to_string();
    ["-m", &p(model), "-f", &p(wav), "-of", &p(out_prefix), "-l", language, "-oj", "-np"].iter().map(|s| s.to_string()).collect()
}

/// Convert `whisper-cli -oj` output into JSON lines `{"start":ms,"end":ms,"text":...}`.
pub fn cli_json_to_lines(json: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("unreadable whisper-cli output: {e}"))?;
    let segments = v.get("transcription").and_then(Value::as_array).ok_or("whisper-cli output has no `transcription` array")?;
    let mut lines = Vec::new();
    for seg in segments {
        let ms = |key: &str| -> Option<i64> {
            seg.pointer(&format!("/offsets/{key}"))
                .and_then(Value::as_i64)
                .or_else(|| seg.pointer(&format!("/timestamps/{key}")).and_then(Value::as_str).and_then(parse_clock_ms))
        };
        let (Some(start), Some(end)) = (ms("from"), ms("to")) else { continue };
        let text = seg.get("text").and_then(Value::as_str).unwrap_or("");
        lines.push(serde_json::json!({ "start": start, "end": end, "text": text }).to_string());
    }
    Ok(lines.join("\n"))
}

/// `HH:MM:SS,mmm` (or `.mmm`) to milliseconds.
fn parse_clock_ms(s: &str) -> Option<i64> {
    let (hms, frac) = s.split_once([',', '.'])?;
    let mut parts = hms.split(':');
    let (h, m, sec): (i64, i64, i64) = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    if parts.next().is_some() {
        return None;
    }
    let millis: i64 = format!("{frac:0<3}").get(..3)?.parse().ok()?;
    Some(((h * 60 + m) * 60 + sec) * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILTERS_WITH_WHISPER: &str = "Filters:\n  T.. = Timeline support\n  .S. = Slice threading\n ... anull             A->A       Do nothing, pass the audio through unchanged.\n ... volume            A->A       Change input volume.\n ... whisper           A->A       Transcribe audio using whisper.cpp.\n ... zoompan           V->V       Apply Zoom & Pan effect.\n";
    const FILTERS_WITHOUT: &str = "Filters:\n  T.. = Timeline support\n ... anull             A->A       Do nothing, pass the audio through unchanged.\n ... whispering_fx     A->A       Not the real thing.\n ... zoompan           V->V       Apply Zoom & Pan effect.\n";

    fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
    }

    fn parse_lines(s: &str) -> Vec<Value> {
        s.lines().map(|l| serde_json::from_str(l).expect("each line is valid JSON")).collect()
    }

    #[test]
    fn detects_the_whisper_filter_by_exact_name() {
        assert!(filters_include_whisper(FILTERS_WITH_WHISPER));
        assert!(!filters_include_whisper(FILTERS_WITHOUT), "'whispering_fx' is not 'whisper'");
        assert!(!filters_include_whisper(""));
    }

    #[test]
    fn cli_args_point_whisper_cli_at_model_audio_and_json_output() {
        let a = cli_args(Path::new("/m/ggml-base.bin"), Path::new("/t/a.wav"), Path::new("/t/out"), "auto");
        assert_eq!(value_after(&a, "-m"), Some("/m/ggml-base.bin"));
        assert_eq!(value_after(&a, "-f"), Some("/t/a.wav"));
        assert_eq!(value_after(&a, "-of"), Some("/t/out"));
        assert_eq!(value_after(&a, "-l"), Some("auto"));
        assert!(a.iter().any(|x| x == "-oj"), "JSON output requested");
        assert!(a.iter().any(|x| x == "-np"), "no progress/prints on stdout");
    }

    #[test]
    fn converts_offsets_to_millisecond_json_lines() {
        let json = r#"{"result":{"language":"en"},"transcription":[
            {"timestamps":{"from":"00:00:00,000","to":"00:00:02,340"},"offsets":{"from":0,"to":2340},"text":" Describe it."},
            {"timestamps":{"from":"00:00:02,340","to":"00:00:05,000"},"offsets":{"from":2340,"to":5000},"text":" Claude writes the motion."}]}"#;
        let lines = parse_lines(&cli_json_to_lines(json).unwrap());
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["start"], 0);
        assert_eq!(lines[0]["end"], 2340);
        assert_eq!(lines[0]["text"].as_str().unwrap().trim(), "Describe it.");
        assert_eq!(lines[1]["start"], 2340);
        assert_eq!(lines[1]["end"], 5000);
    }

    #[test]
    fn falls_back_to_timestamp_strings_when_offsets_are_missing() {
        let json = r#"{"transcription":[{"timestamps":{"from":"00:00:01,500","to":"00:01:02,250"},"text":"late"}]}"#;
        let lines = parse_lines(&cli_json_to_lines(json).unwrap());
        assert_eq!(lines[0]["start"], 1500);
        assert_eq!(lines[0]["end"], 62250);
    }

    #[test]
    fn skips_segments_without_usable_times() {
        let json = r#"{"transcription":[{"text":"no times"},{"offsets":{"from":10,"to":20},"text":"ok"}]}"#;
        let lines = parse_lines(&cli_json_to_lines(json).unwrap());
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["text"], "ok");
    }

    #[test]
    fn empty_transcript_is_an_empty_string() {
        assert_eq!(cli_json_to_lines(r#"{"transcription":[]}"#).unwrap(), "");
    }

    #[test]
    fn rejects_malformed_or_unexpected_json() {
        assert!(cli_json_to_lines("not json").is_err());
        let err = cli_json_to_lines(r#"{"result":{}}"#).unwrap_err();
        assert!(err.contains("transcription"), "{err}");
    }

    #[test]
    fn language_codes_are_validated_before_reaching_ffmpeg_or_the_cli() {
        for ok in ["auto", "en", "de", "yue"] {
            assert_eq!(validate_language(ok).unwrap(), ok);
        }
        for bad in ["", "EN", "english", "en:destination=/tmp/x", "en,x", "../x", "-oj", "e n", "e"] {
            assert!(validate_language(bad).is_err(), "{bad:?}");
        }
    }
}
