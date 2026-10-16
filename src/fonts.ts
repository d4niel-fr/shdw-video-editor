// Project fonts (fonts/*.ttf|otf|woff|woff2) are registered as FontFaces
// named after the file stem; plus a curated list of system families.

import { fs, mediaUrl, stem, ext, FONT_EXT, join } from "./ipc";
import { store } from "./store";

const loaded = new Map<string, FontFace>();
const SYSTEM = ["Inter", "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", "Arial", "Helvetica", "Georgia", "Times New Roman",
  "Courier New", "Consolas", "Impact", "Bahnschrift", "Trebuchet MS", "Verdana", "Cambria", "Candara", "Franklin Gothic Medium", "Gabriola", "Segoe Script", "Comic Sans MS"];

export function fontFamilies() {
  return [...new Set([...loaded.keys(), ...SYSTEM])];
}

export async function loadProjectFonts() {
  let entries;
  try { entries = await fs.list(join(store.dir, "fonts")); } catch { return; }
  for (const e of entries) {
    if (e.isDir || !FONT_EXT.includes(ext(e.name))) continue;
    const fam = stem(e.name);
    const key = fam + "@" + e.modified;
    if (loaded.has(fam) && (loaded.get(fam) as any).__key === key) continue;
    try {
      // a font still being written (download/copy in progress) fails at first — retry with a fresh FontFace before reporting
      let ff: FontFace;
      for (let i = 0; ; i++) {
        ff = new FontFace(fam, `url("${mediaUrl(e.path)}?v=${i}")`);
        try { await ff.load(); break; } catch (err) { if (i >= 3) throw err; await new Promise((r) => setTimeout(r, 600 * (i + 1))); }
      }
      (ff as any).__key = key;
      store.clearErrors(e.name);
      if (loaded.has(fam)) document.fonts.delete(loaded.get(fam)!);
      document.fonts.add(ff);
      loaded.set(fam, ff);
    } catch (err) {
      store.error(e.name, "font failed to load: " + err);
    }
  }
  store.emit("fonts");
  store.emit("frame-ready");
}
