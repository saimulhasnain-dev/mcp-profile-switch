import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { estimateTokens, listTools } from "../src/cost.js";
import { createToolFilter } from "../src/proxy.js";

const FIXTURE = resolve("test/fixtures/fake-server.mjs");
const CLI = resolve("build-test/src/cli.js");
const node = process.execPath;

test("filter trims tools/list responses and only those", () => {
  const f = createToolFilter(["read_*"]);
  assert.deepEqual(f.fromClient('{"jsonrpc":"2.0","id":7,"method":"tools/list"}'), {
    forward: '{"jsonrpc":"2.0","id":7,"method":"tools/list"}',
    reply: undefined,
  });
  const out = JSON.parse(f.fromServer(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [{ name: "read_a" }, { name: "rm" }] } })));
  assert.deepEqual(out.result.tools, [{ name: "read_a" }]);
  // a different response with a tools field is not touched
  const other = JSON.stringify({ jsonrpc: "2.0", id: 8, result: { tools: [{ name: "rm" }] } });
  assert.equal(f.fromServer(other), other);
  assert.equal(f.fromServer("not json"), "not json");
});

test("filter blocks calls to hidden tools without reaching the server", () => {
  const f = createToolFilter(["read_*"]);
  const blocked = f.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rm" } }));
  assert.equal(blocked.forward, undefined);
  assert.equal(JSON.parse(blocked.reply!).error.code, -32602);
  const allowed = f.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_a" } }));
  assert.ok(allowed.forward);
  assert.equal(allowed.reply, undefined);
});

test("filter handles JSON-RPC batches", () => {
  const f = createToolFilter(["ok"]);
  const r = f.fromClient(
    JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ok" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bad" } },
    ]),
  );
  assert.equal(JSON.parse(r.forward!).length, 1);
  assert.equal(JSON.parse(r.reply!)[0].id, 2);
});

test("estimateTokens grows with description and schema size", () => {
  const small = estimateTokens({ name: "a" });
  const big = estimateTokens({ name: "a", description: "x".repeat(400), inputSchema: { type: "object" } });
  assert.ok(small > 0);
  assert.ok(big >= small + 100);
});

test("listTools reads every page from a stdio server", async () => {
  const tools = await listTools({ command: node, args: [FIXTURE] });
  assert.deepEqual(tools.map((t) => t.name), ["read_file", "write_file", "delete_everything"]);
});

test("proxy CLI exposes only allowed tools end to end", async () => {
  const proxied = { command: node, args: [CLI, "proxy", "--allow", "*_file", "--", node, FIXTURE] };
  const tools = await listTools(proxied);
  assert.deepEqual(tools.map((t) => t.name), ["read_file", "write_file"]);
});

test("proxy CLI rejects calls to hidden tools and forwards allowed ones", async () => {
  const child = spawn(node, [CLI, "proxy", "--allow", "read_file", "--", node, FIXTURE], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map<number, any>();
  const done = new Promise<void>((res) => {
    createInterface({ input: child.stdout }).on("line", (l) => {
      const m = JSON.parse(l);
      replies.set(m.id, m);
      if (replies.size === 2) res();
    });
  });
  const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "tools/call", params: { name: "delete_everything" } });
  send({ id: 2, method: "tools/call", params: { name: "read_file" } });
  await done;
  child.kill();
  assert.match(replies.get(1).error.message, /not enabled/);
  assert.equal(replies.get(2).result.content[0].text, "called read_file");
});
