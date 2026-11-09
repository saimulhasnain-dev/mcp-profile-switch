import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { buildServers, unknownServers, writeTarget } from "../src/targets.js";

const cfg = parseConfig(
  JSON.stringify({
    servers: {
      fs: { command: "node", args: ["fs.js"], env: { ROOT: "/tmp" } },
      docs: { url: "https://example.com/mcp" },
      other: { command: "other" },
    },
    profiles: {
      dev: { servers: ["fs", "docs"], tools: { fs: ["read_*", "list_dir"] } },
      bad: { servers: ["docs"], tools: { docs: ["x"] } },
    },
  }),
);

test("buildServers keeps only profile servers and wraps filtered ones in the proxy", () => {
  const servers = buildServers(cfg, "dev");
  assert.deepEqual(Object.keys(servers), ["fs", "docs"]);
  assert.deepEqual(servers.fs, {
    command: "npx",
    args: ["-y", "mcp-profile-switch", "proxy", "--allow", "read_*", "--allow", "list_dir", "--", "node", "fs.js"],
    env: { ROOT: "/tmp" },
  });
  assert.deepEqual(servers.docs, { url: "https://example.com/mcp" });
});

test("buildServers honours a custom proxy command and rejects filtering remote servers", () => {
  const servers = buildServers(cfg, "dev", ["mcp-profile-switch"]);
  assert.equal((servers.fs as { command: string }).command, "mcp-profile-switch");
  assert.throws(() => buildServers(cfg, "bad"), /needs a stdio server/);
  assert.throws(() => buildServers(cfg, "missing"), /Unknown profile "missing"/);
});

test("writeTarget writes each client's format", () => {
  const dir = mkdtempSync(join(tmpdir(), "mps-"));
  const servers = buildServers(cfg, "dev");

  const claude = JSON.parse(readFileSync(writeTarget(dir, "claude", servers), "utf8"));
  assert.equal(claude.mcpServers.docs.type, "http");
  assert.equal(claude.mcpServers.fs.command, "npx");

  const cursor = JSON.parse(readFileSync(writeTarget(dir, "cursor", servers), "utf8"));
  assert.deepEqual(cursor.mcpServers.docs, { url: "https://example.com/mcp" });

  const vscode = JSON.parse(readFileSync(writeTarget(dir, "vscode", servers), "utf8"));
  assert.equal(vscode.servers.fs.type, "stdio");
});

test("unknownServers reports hand-written servers that a switch would drop", () => {
  const dir = mkdtempSync(join(tmpdir(), "mps-"));
  assert.deepEqual(unknownServers(dir, "claude", cfg), [], "no file yet");
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "x" }, handmade: { command: "y" } } }));
  assert.deepEqual(unknownServers(dir, "claude", cfg), ["handmade"]);
  writeTarget(dir, "claude", buildServers(cfg, "dev"));
  assert.deepEqual(unknownServers(dir, "claude", cfg), [], "files we wrote only contain known servers");
});

test("writeTarget replaces the server map but keeps other keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "mps-"));
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(join(dir, ".vscode", "mcp.json"), JSON.stringify({ inputs: [{ id: "tok" }], servers: { stale: { command: "x" } } }));
  const doc = JSON.parse(readFileSync(writeTarget(dir, "vscode", buildServers(cfg, "dev")), "utf8"));
  assert.deepEqual(doc.inputs, [{ id: "tok" }]);
  assert.deepEqual(Object.keys(doc.servers), ["fs", "docs"]);
});
