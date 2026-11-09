import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { matchTool } from "./config.js";

type Msg = Record<string, any>;

/**
 * Pure line-level filter for a newline-delimited JSON-RPC (MCP stdio) stream.
 * - `tools/list` results from the server are trimmed to the allowlist.
 * - `tools/call` for a hidden tool is answered with an error and never reaches the server.
 * Anything else passes through untouched.
 */
export function createToolFilter(allow: string[]) {
  const pendingLists = new Set<string | number>();

  const fromClient = (line: string): { forward?: string; reply?: string } => {
    const parsed = tryParse(line);
    if (parsed === undefined) return { forward: line };
    const msgs: Msg[] = Array.isArray(parsed) ? parsed : [parsed];
    const forward: Msg[] = [];
    const replies: Msg[] = [];
    for (const m of msgs) {
      if (m?.method === "tools/list" && m.id !== undefined) pendingLists.add(m.id);
      const tool = m?.method === "tools/call" ? m.params?.name : undefined;
      if (typeof tool === "string" && !matchTool(tool, allow)) {
        if (m.id !== undefined) {
          replies.push({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Tool "${tool}" is not enabled in this MCP profile` } });
        }
      } else {
        forward.push(m);
      }
    }
    const pack = (list: Msg[]) => (list.length === 0 ? undefined : JSON.stringify(Array.isArray(parsed) ? list : list[0]));
    return { forward: pack(forward), reply: pack(replies) };
  };

  const fromServer = (line: string): string => {
    const parsed = tryParse(line);
    if (parsed === undefined) return line;
    let changed = false;
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (m && m.id !== undefined && pendingLists.has(m.id) && (m.result || m.error)) {
        pendingLists.delete(m.id);
        if (Array.isArray(m.result?.tools)) {
          m.result.tools = m.result.tools.filter((t: Msg) => matchTool(String(t?.name), allow));
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(parsed) : line;
  };

  return { fromClient, fromServer };
}

function tryParse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Run `command args...` as a child MCP server and filter its tools over stdio. Resolves with the exit code. */
export function runProxy(allow: string[], command: string, args: string[]): Promise<number> {
  const filter = createToolFilter(allow);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });

  createInterface({ input: process.stdin }).on("line", (line) => {
    const { forward, reply } = filter.fromClient(line);
    if (forward !== undefined) child.stdin.write(forward + "\n");
    if (reply !== undefined) process.stdout.write(reply + "\n");
  });
  process.stdin.on("end", () => child.stdin.end());
  createInterface({ input: child.stdout }).on("line", (line) => {
    process.stdout.write(filter.fromServer(line) + "\n");
  });

  return new Promise((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`mcp-profile-switch proxy: failed to start ${command}: ${err.message}\n`);
      resolve(1);
    });
    // "close" fires after the child's stdout is drained, so no response is lost.
    child.on("close", (code) => resolve(code ?? 1));
  });
}
