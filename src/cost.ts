import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { StdioServer } from "./config.js";

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

/**
 * Rough token cost of a tool definition as a model sees it: the JSON of its
 * name, description and input schema, at ~4 characters per token.
 * It's an estimate, not a tokenizer, but it is consistent enough to rank tools.
 */
export function estimateTokens(tool: Tool): number {
  const json = JSON.stringify({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} });
  return Math.ceil(json.length / 4);
}

/** Start a stdio MCP server, run initialize + tools/list (following pagination), then stop it. */
export function listTools(server: StdioServer, timeoutMs = 30_000): Promise<Tool[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args ?? [], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...server.env },
      cwd: server.cwd,
      shell: process.platform === "win32",
    });
    const tools: Tool[] = [];
    let nextId = 1;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      err ? reject(err) : resolve(tools);
    };
    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    const requestTools = (cursor?: string) => send({ id: ++nextId, method: "tools/list", params: cursor ? { cursor } : {} });

    child.on("error", (err) => finish(err));
    child.on("exit", (code) => finish(new Error(`server exited (code ${code}) before listing tools`)));
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === undefined || msg.method) return;
      if (msg.error) return finish(new Error(msg.error.message ?? "server error"));
      if (msg.id === 1) {
        send({ method: "notifications/initialized" });
        return requestTools();
      }
      tools.push(...(msg.result?.tools ?? []));
      if (msg.result?.nextCursor) requestTools(msg.result.nextCursor);
      else finish();
    });

    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-profile-switch", version: "0.1.0" } },
    });
  });
}
