import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getProfile, isStdio, type ProfilesFile, type ServerConfig } from "./config.js";

export type Target = "claude" | "cursor" | "vscode";
export const TARGETS: Target[] = ["claude", "cursor", "vscode"];

/** Where each client reads its project-scoped MCP config, and under which key. */
const TARGET_FILES: Record<Target, { file: string; key: string }> = {
  claude: { file: ".mcp.json", key: "mcpServers" },
  cursor: { file: join(".cursor", "mcp.json"), key: "mcpServers" },
  vscode: { file: join(".vscode", "mcp.json"), key: "servers" },
};

export const DEFAULT_PROXY_COMMAND = ["npx", "-y", "mcp-profile-switch"];

/**
 * Resolve a profile to concrete server entries. Stdio servers with a tool
 * allowlist are wrapped in `mcp-profile-switch proxy --allow ... -- <cmd>`.
 */
export function buildServers(
  cfg: ProfilesFile,
  profileName: string,
  proxyCommand: string[] = DEFAULT_PROXY_COMMAND,
): Record<string, ServerConfig> {
  const profile = getProfile(cfg, profileName);
  const out: Record<string, ServerConfig> = {};
  for (const name of profile.servers) {
    const server = cfg.servers[name];
    const allow = profile.tools?.[name];
    if (!allow) {
      out[name] = server;
      continue;
    }
    if (!isStdio(server)) {
      throw new Error(`Profile "${profileName}": tool filtering for "${name}" needs a stdio server (remote URLs are not proxied)`);
    }
    const [cmd, ...rest] = proxyCommand;
    out[name] = {
      ...server,
      command: cmd,
      args: [...rest, "proxy", ...allow.flatMap((p) => ["--allow", p]), "--", server.command, ...(server.args ?? [])],
    };
  }
  return out;
}

function toClientEntry(target: Target, server: ServerConfig): Record<string, unknown> {
  if (isStdio(server)) return target === "vscode" ? { type: "stdio", ...server } : { ...server };
  if (target === "cursor") return { url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
  return { type: server.type ?? "http", url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
}

/**
 * Servers already in the target file that the profiles file does not define.
 * Overwriting the file would lose them, so the CLI refuses unless --force.
 */
export function unknownServers(dir: string, target: Target, cfg: ProfilesFile): string[] {
  const path = join(dir, TARGET_FILES[target].file);
  if (!existsSync(path)) return [];
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const current = doc?.[TARGET_FILES[target].key];
  if (!current || typeof current !== "object") return [];
  return Object.keys(current).filter((name) => !cfg.servers[name]);
}

/**
 * Write the profile's servers into a client's project config file.
 * Other top-level keys in an existing file (e.g. VS Code "inputs") are kept;
 * the server map is replaced entirely so nothing outside the profile leaks in.
 */
export function writeTarget(dir: string, target: Target, servers: Record<string, ServerConfig>): string {
  const { file, key } = TARGET_FILES[target];
  const path = join(dir, file);
  let doc: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`${path} exists but is not valid JSON; fix or remove it first`);
    }
  }
  doc[key] = Object.fromEntries(Object.entries(servers).map(([n, s]) => [n, toClientEntry(target, s)]));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  return path;
}
