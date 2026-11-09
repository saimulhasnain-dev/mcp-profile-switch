#!/usr/bin/env node
import { parseArgs } from "node:util";
import { findConfig, getProfile, isStdio, loadConfig, matchTool, type Profile, type ProfilesFile } from "./config.js";
import { estimateTokens, listTools } from "./cost.js";
import { runProxy } from "./proxy.js";
import { buildServers, DEFAULT_PROXY_COMMAND, TARGETS, unknownServers, writeTarget, type Target } from "./targets.js";

const USAGE = `mcp-profile-switch — named MCP profiles per project

Usage:
  mcp-profile-switch list                      List profiles
  mcp-profile-switch use <profile> [options]   Write the profile into this project's client config
  mcp-profile-switch cost [profile] [--json]   Token cost of each tool (all servers if no profile)
  mcp-profile-switch proxy --allow <pattern>... -- <command> [args...]
                                               Run an MCP server exposing only allowed tools

Options:
  -c, --config <path>        Profiles file (default: ./mcp-profiles.json, then
                             $MCP_PROFILES or ~/.config/mcp-profile-switch/profiles.json)
  -t, --target <client>      claude | cursor | vscode (repeatable, default: claude)
  -d, --dir <path>           Project directory to write into (default: cwd)
  -f, --force                Overwrite servers in the client config that the profiles file doesn't define
  --proxy-command <cmd>      Command used to launch the proxy (default: "${DEFAULT_PROXY_COMMAND.join(" ")}")
  -h, --help                 Show this help`;

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "proxy") return proxyCommand(argv.slice(1));

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      target: { type: "string", short: "t", multiple: true },
      dir: { type: "string", short: "d" },
      "proxy-command": { type: "string" },
      force: { type: "boolean", short: "f" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, profileName] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd || values.help ? 0 : 1;
  }

  const configPath = findConfig(process.cwd(), values.config);
  const cfg = loadConfig(configPath);

  if (cmd === "list") {
    for (const [name, p] of Object.entries(cfg.profiles)) {
      const servers = p.servers.map((s) => (p.tools?.[s] ? `${s}(${p.tools[s].length} tools)` : s)).join(", ");
      console.log(`${name}${p.description ? ` — ${p.description}` : ""}\n  ${servers || "(no servers)"}`);
    }
    return 0;
  }

  if (cmd === "use") {
    if (!profileName) throw new Error("usage: mcp-profile-switch use <profile>");
    const targets = (values.target ?? ["claude"]).flatMap((t) => t.split(",")) as Target[];
    for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`Unknown target "${t}" (use ${TARGETS.join(", ")})`);
    const proxy = values["proxy-command"]?.split(" ").filter(Boolean) ?? DEFAULT_PROXY_COMMAND;
    const servers = buildServers(cfg, profileName, proxy);
    const dir = values.dir ?? process.cwd();
    if (!values.force) {
      for (const t of targets) {
        const lost = unknownServers(dir, t, cfg);
        if (lost.length) {
          throw new Error(
            `${t} config has servers not in ${configPath}: ${lost.join(", ")}.\n` +
              `Add them to the profiles file's "servers" first, or re-run with --force to drop them.`,
          );
        }
      }
    }
    for (const t of targets) console.log(`${t}: wrote ${writeTarget(dir, t, servers)}`);
    console.log(`Profile "${profileName}" active (${Object.keys(servers).length} servers). Restart your client to pick it up.`);
    return 0;
  }

  if (cmd === "cost") return costCommand(cfg, profileName, values.json ?? false);

  throw new Error(`Unknown command "${cmd}"\n\n${USAGE}`);
}

async function costCommand(cfg: ProfilesFile,profileName: string | undefined, json: boolean): Promise<number> {
  const profile: Profile = profileName ? getProfile(cfg, profileName) : { servers: Object.keys(cfg.servers) };
  const report: { server: string; error?: string; tools: { name: string; tokens: number; exposed: boolean }[]; unmatched: string[] }[] = [];
  let failed = false;

  for (const name of profile.servers) {
    const server = cfg.servers[name];
    const allow = profile.tools?.[name];
    if (!isStdio(server)) {
      report.push({ server: name, error: "remote server; only stdio servers can be inspected", tools: [], unmatched: [] });
      continue;
    }
    try {
      const tools = (await listTools(server)).map((t) => ({
        name: t.name,
        tokens: estimateTokens(t),
        exposed: !allow || matchTool(t.name, allow),
      }));
      tools.sort((a, b) => b.tokens - a.tokens);
      const unmatched = (allow ?? []).filter((p) => !tools.some((t) => matchTool(t.name, [p])));
      report.push({ server: name, tools, unmatched });
    } catch (e) {
      failed = true;
      report.push({ server: name, error: (e as Error).message, tools: [], unmatched: [] });
    }
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  }

  const fmt = (n: number) => n.toLocaleString("en-US");
  let exposedTotal = 0;
  let hiddenTotal = 0;
  for (const r of report) {
    if (r.error) {
      console.log(`${r.server}: ${r.error}\n`);
      continue;
    }
    const exposed = r.tools.filter((t) => t.exposed);
    const ex = exposed.reduce((s, t) => s + t.tokens, 0);
    const hid = r.tools.reduce((s, t) => s + t.tokens, 0) - ex;
    exposedTotal += ex;
    hiddenTotal += hid;
    console.log(`${r.server}  (${exposed.length}/${r.tools.length} tools exposed, ~${fmt(ex)} tokens)`);
    for (const t of r.tools) console.log(`  ${t.exposed ? "+" : "-"} ${fmt(t.tokens).padStart(6)}  ${t.name}`);
    for (const p of r.unmatched) console.log(`  ! allowlist pattern "${p}" matches no tool`);
    console.log("");
  }
  console.log(`Total exposed: ~${fmt(exposedTotal)} tokens` + (hiddenTotal ? `  (hidden by profile: ~${fmt(hiddenTotal)})` : ""));
  return failed ? 1 : 0;
}

async function proxyCommand(argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) throw new Error("usage: mcp-profile-switch proxy --allow <pattern>... -- <command> [args...]");
  const { values } = parseArgs({ args: argv.slice(0, sep), options: { allow: { type: "string", multiple: true, short: "a" } } });
  const [command, ...args] = argv.slice(sep + 1);
  const code = await runProxy(values.allow ?? [], command, args);
  // stdin may still be open; the server is gone, so exit once stdout is flushed.
  process.stdout.write("", () => process.exit(code));
  return new Promise<number>(() => {});
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`mcp-profile-switch: ${err.message}`);
    process.exitCode = 1;
  },
);
