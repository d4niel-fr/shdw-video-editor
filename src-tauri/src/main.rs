#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod control;
mod decoder;
mod export;
mod html;
mod media;
mod mediaproto;
mod project;
mod tools;

use tauri::Manager;

fn main() {
    tools::kill_children_on_exit();
    html::cleanup_orphans();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, request, responder| {
            std::thread::spawn(move || responder.respond(mediaproto::serve(request)));
        })
        .manage(agent::AgentState::default())
        .manage(export::ExportState::default())
        .manage(project::WatchState::default())
        .manage(control::ControlState::default())
        .manage(decoder::DecoderState::default())
        .manage(html::HtmlState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            control::start(handle, &app.state::<control::ControlState>());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project::project_init,
            project::watch_dir,
            project::read_text,
            project::write_text,
            project::read_bytes,
            project::write_bytes,
            project::list_dir,
            project::copy_file,
            project::remove_path,
            project::exists,
            project::reveal,
            project::env_info,
            project::startup_project,
            media::probe,
            media::thumbnails,
            media::waveform,
            media::make_proxy,
            media::mixdown,
            media::transcribe,
            media::detect_scenes,
            media::detect_silence,
            media::loudness,
            media::ffmpeg_process,
            html::html_frame,
            html::html_reset,
            export::export_start,
            export::export_frame,
            export::export_finish,
            export::export_cancel,
            agent::agent_start,
            agent::agent_stop,
            agent::agent_kill_pid,
            control::control_respond,
            control::control_port,
            decoder::decoder_open,
            decoder::decoder_read,
            decoder::decoder_close_all,
        ])
        .build(tauri::generate_context!())
        .expect("error while building shdw")
        .run(|app, ev| {
            if let tauri::RunEvent::Exit = ev {
                html::shutdown(&app.state::<html::HtmlState>());
                agent::shutdown(&app.state::<agent::AgentState>());
                decoder_shutdown(app);
            }
        });
}

fn decoder_shutdown(app: &tauri::AppHandle) {
    decoder::decoder_close_all(app.state::<decoder::DecoderState>());
}
