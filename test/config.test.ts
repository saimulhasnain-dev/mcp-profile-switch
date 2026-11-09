import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findConfig, matchTool, parseConfig } from "../src/config.js";

const valid = {
  servers: { fs: { command: "node", args: ["fs.js"] }, docs: { url: "https://example.com/mcp" } },
  profiles: { dev: { servers: ["fs", "docs"], tools: { fs: ["read_*"] } } },
};

test("parseConfig accepts a valid file", () => {
  const cfg = parseConfig(JSON.stringify(valid));
  assert.deepEqual(cfg.profiles.dev.servers, ["fs", "docs"]);
});

test("parseConfig rejects unknown servers and stray tool lists", () => {
  assert.throws(
    () => parseConfig(JSON.stringify({ ...valid, profiles: { x: { servers: ["nope"] } } })),
    /unknown server "nope"/,
  );
  assert.throws(
    () => parseConfig(JSON.stringify({ ...valid, profiles: { x: { servers: ["fs"], tools: { docs: ["a"] } } } })),
    /not in its servers/,
  );
  assert.throws(() => parseConfig("{"), /invalid JSON/);
  assert.throws(() => parseConfig(JSON.stringify({ servers: { a: {} }, profiles: {} })), /"command" or a "url"/);
});

test("matchTool supports exact names and * globs", () => {
  assert.equal(matchTool("read_file", ["read_file"]), true);
  assert.equal(matchTool("read_file", ["read_*"]), true);
  assert.equal(matchTool("write_file", ["read_*"]), false);
  assert.equal(matchTool("anything", ["*"]), true);
  assert.equal(matchTool("a.b", ["a.c"]), false, "dots are literal");
  assert.equal(matchTool("x", []), false);
});

test("findConfig prefers explicit, then local, then global", () => {
  const dir = mkdtempSync(join(tmpdir(), "mps-"));
  const env = { XDG_CONFIG_HOME: "/xdg" };
  assert.equal(findConfig(dir, undefined, env), join("/xdg", "mcp-profile-switch", "profiles.json"));
  assert.equal(findConfig(dir, undefined, { MCP_PROFILES: "/p.json" }), "/p.json");
  writeFileSync(join(dir, "mcp-profiles.json"), "{}");
  assert.equal(findConfig(dir, undefined, env), join(dir, "mcp-profiles.json"));
  assert.equal(findConfig(dir, "other.json", env), join(dir, "other.json"));
});
