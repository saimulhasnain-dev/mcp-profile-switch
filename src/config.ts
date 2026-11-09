import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface StdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface RemoteServer {
  url: string;
  type?: "http" | "sse";
  headers?: Record<string, string>;
}

export type ServerConfig = StdioServer | RemoteServer;

export interface Profile {
  description?: string;
  /** Names of servers (keys of `servers`) this profile exposes. */
  servers: string[];
  /** Optional per-server tool allowlist. Patterns may use `*`. Servers not listed expose all tools. */
  tools?: Record<string, string[]>;
}

export interface ProfilesFile {
  servers: Record<string, ServerConfig>;
  profiles: Record<string, Profile>;
}

export const CONFIG_FILENAME = "mcp-profiles.json";

export function isStdio(server: ServerConfig): server is StdioServer {
  return typeof (server as StdioServer).command === "string";
}

/** Global config location: $MCP_PROFILES, else $XDG_CONFIG_HOME (or ~/.config)/mcp-profile-switch/profiles.json */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MCP_PROFILES) return resolve(env.MCP_PROFILES);
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "mcp-profile-switch", "profiles.json");
}

/** Explicit path > ./mcp-profiles.json > global config. */
export function findConfig(cwd: string, explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit) return resolve(cwd, explicit);
  const local = join(cwd, CONFIG_FILENAME);
  if (existsSync(local)) return local;
  return globalConfigPath(env);
}

export function parseConfig(text: string, source = "config"): ProfilesFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source}: invalid JSON (${(e as Error).message})`);
  }
  const cfg = raw as ProfilesFile;
  if (!cfg || typeof cfg !== "object" || typeof cfg.servers !== "object" || typeof cfg.profiles !== "object") {
    throw new Error(`${source}: expected an object with "servers" and "profiles"`);
  }
  for (const [name, server] of Object.entries(cfg.servers)) {
    if (!server || (typeof (server as StdioServer).command !== "string" && typeof (server as RemoteServer).url !== "string")) {
      throw new Error(`${source}: server "${name}" needs a "command" or a "url"`);
    }
  }
  for (const [name, profile] of Object.entries(cfg.profiles)) {
    if (!Array.isArray(profile?.servers)) throw new Error(`${source}: profile "${name}" needs a "servers" array`);
    for (const s of profile.servers) {
      if (!cfg.servers[s]) throw new Error(`${source}: profile "${name}" references unknown server "${s}"`);
    }
    for (const [s, patterns] of Object.entries(profile.tools ?? {})) {
      if (!profile.servers.includes(s)) throw new Error(`${source}: profile "${name}" lists tools for "${s}", which is not in its servers`);
      if (!Array.isArray(patterns)) throw new Error(`${source}: profile "${name}" tools for "${s}" must be an array`);
    }
  }
  return cfg;
}

export function loadConfig(path: string): ProfilesFile {
  if (!existsSync(path)) {
    throw new Error(`No profiles file found at ${path}. Create ./${CONFIG_FILENAME} or pass --config.`);
  }
  return parseConfig(readFileSync(path, "utf8"), path);
}

export function getProfile(cfg: ProfilesFile, name: string): Profile {
  const profile = cfg.profiles[name];
  if (!profile) {
    const known = Object.keys(cfg.profiles).join(", ") || "(none)";
    throw new Error(`Unknown profile "${name}". Known profiles: ${known}`);
  }
  return profile;
}

/** True if `name` matches any pattern. `*` matches any run of characters. */
export function matchTool(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(name);
  });
}
