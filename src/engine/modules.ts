// Loads agent/user-written ES modules (motion clips, transitions, effects,
// blends) from the project folder with cache-busting hot reload.

import { fs, norm } from "../ipc";
import { store } from "../store";
import type { ParamSpec } from "./shaders";

export interface UserModule {
  name?: string;
  duration?: number;
  params?: Record<string, ParamSpec>;
  render?: (ctx: CanvasRenderingContext2D, t: number, api: any) => void;
  setup?: (api: any) => void;
  fragment?: string;
  /** set by loader */
  __version: number;
  __path: string;
}

const cache = new Map<string, UserModule>();
const loading = new Map<string, Promise<UserModule | null>>();
const failed = new Map<string, string>();
let version = 1;

export function moduleVersion() { return version; }

/** Synchronous accessor; kicks off a load if needed and returns null until ready. */
export function getModule(relPath: string): UserModule | null {
  const key = norm(relPath);
  const m = cache.get(key);
  if (m) return m;
  if (!loading.has(key) && !failed.has(key)) void loadModule(key);
  return null;
}

export function pendingModules() { return loading.size; }
export function moduleError(relPath: string) { return failed.get(norm(relPath)); }

export async function loadModule(relPath: string): Promise<UserModule | null> {
  const key = norm(relPath);
  if (loading.has(key)) return loading.get(key)!;
  const p = (async () => {
    try {
      const code = await fs.readText(store.abs(key));
      const url = URL.createObjectURL(new Blob([code + `\n//# sourceURL=${key}`], { type: "text/javascript" }));
      try {
        const mod = await import(/* @vite-ignore */ url);
        const def = (mod.default ?? mod) as UserModule;
        if (typeof def !== "object" || (!def.render && !def.fragment)) throw new Error("module must `export default { render(ctx,t,api) }` or `{ fragment: \"...glsl...\" }`");
        def.__version = ++version;
        def.__path = key;
        cache.set(key, def);
        failed.delete(key);
        store.clearErrors(key);
        return def;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e: any) {
      failed.set(key, e?.message ?? String(e));
      store.error(key, e?.message ?? String(e));
      return null;
    } finally {
      loading.delete(key);
      store.emit("modules");
    }
  })();
  loading.set(key, p);
  return p;
}

/** Called by the folder watcher. */
export function invalidateModule(absOrRel: string) {
  const rel = norm(store.rel(absOrRel));
  if (!/\.(m?js)$/.test(rel)) return false;
  // only reload modules something has asked for — plain helper scripts next to them are not modules
  const used = cache.has(rel) || failed.has(rel) || loading.has(rel);
  cache.delete(rel);
  failed.delete(rel);
  if (used) store.clearErrors(rel);
  version++;
  if (used) void loadModule(rel);
  return true;
}

export function invalidateAll() {
  cache.clear(); failed.clear(); version++;
  store.emit("modules");
}

/** Enumerate module files of a folder (motion/, transitions/, effects/, blends/). */
export async function listModules(folder: string) {
  try {
    const entries = await fs.list(store.abs(folder));
    return entries.filter((e) => !e.isDir && /\.m?js$/.test(e.name)).map((e) => `${folder}/${e.name}`);
  } catch {
    return [];
  }
}

export function paramUniforms(params?: Record<string, ParamSpec>, values?: Record<string, any>) {
  const decl: string[] = [];
  const keys = new Set([...Object.keys(params ?? {}), ...Object.keys(values ?? {})]);
  for (const k of keys) {
    if (!/^[A-Za-z_]\w*$/.test(k)) continue;
    const spec = params?.[k];
    const v = values?.[k] ?? spec?.default;
    const type = spec?.type ?? (typeof v === "string" && v.startsWith("#") ? "color" : typeof v === "number" || typeof v === "boolean" ? "number" : "text");
    if (type === "color") decl.push(`uniform vec3 u_${k};`);
    else if (type === "number" || type === "bool") decl.push(`uniform float u_${k};`);
  }
  return decl.join("\n");
}

export function paramValues(params?: Record<string, ParamSpec>, values?: Record<string, any>) {
  const out: Record<string, number | number[]> = {};
  const keys = new Set([...Object.keys(params ?? {}), ...Object.keys(values ?? {})]);
  for (const k of keys) {
    const v = values?.[k] ?? params?.[k]?.default;
    if (typeof v === "number") out[`u_${k}`] = v;
    else if (typeof v === "boolean") out[`u_${k}`] = v ? 1 : 0;
    else if (typeof v === "string" && v.startsWith("#")) {
      let s = v.slice(1); if (s.length === 3) s = s.split("").map((c) => c + c).join("");
      const n = parseInt(s.slice(0, 6), 16);
      out[`u_${k}`] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    } else if (Array.isArray(v)) out[`u_${k}`] = v;
  }
  return out;
}

export function defaultsOf(params?: Record<string, ParamSpec>) {
  const o: Record<string, any> = {};
  for (const [k, s] of Object.entries(params ?? {})) o[k] = s.default;
  return o;
}
