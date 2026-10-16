import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export { invoke, listen };

export interface DirEntry { name: string; path: string; isDir: boolean; size: number; modified: number }

export const fs = {
  readText: (path: string) => invoke<string>("read_text", { path }),
  writeText: (path: string, content: string) => invoke<void>("write_text", { path, content }),
  readBytes: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_bytes", { path })),
  writeBytes: (path: string, data: Uint8Array) =>
    invoke<void>("write_bytes", data, { headers: { "x-path": encodeURIComponent(path) } }),
  list: (path: string, recursive = false) => invoke<DirEntry[]>("list_dir", { path, recursive }),
  copy: (src: string, dst: string) => invoke<void>("copy_file", { src, dst }),
  remove: (path: string) => invoke<void>("remove_path", { path }),
  exists: (path: string) => invoke<boolean>("exists", { path }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
};

export const norm = (p: string) => p.replace(/\\/g, "/");
export const isAbs = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
export const join = (...parts: string[]) => norm(parts.filter(Boolean).join("/")).replace(/\/+/g, "/");
export const basename = (p: string) => norm(p).split("/").pop() ?? p;
export const stem = (p: string) => basename(p).replace(/\.[^.]+$/, "");
export const ext = (p: string) => (basename(p).match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
export const dirname = (p: string) => norm(p).split("/").slice(0, -1).join("/");

/** Webview URL for a local file (CORS + range enabled custom protocol). */
export const mediaUrl = (absPath: string) => `http://media.localhost/${encodeURIComponent(norm(absPath))}`;

export const VIDEO_EXT = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "mxf", "mts", "m2ts", "wmv", "flv", "3gp", "ts", "mpg", "mpeg"];
export const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aif", "aiff", "wma"];
export const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff", "avif"];
export const FONT_EXT = ["ttf", "otf", "woff", "woff2"];
