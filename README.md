# mcp-profile-switch

Named MCP profiles for each project. You list your MCP servers once, then define profiles such as `frontend`, `backend` or `debug-perf`. Each profile says which servers it uses and, if you want, which tools from each server. One command writes that profile into the project's Claude Code, Cursor or VS Code config.

With fewer tools in context, the model is less likely to pick the wrong one. You also stop paying tokens for tools you don't use, and one work context's servers stop showing up in another.

- **Profiles**: one file holds every server and every profile.
- **Switch per project**: `mcp-profile-switch use frontend`
- **Tool allowlists**: hidden tools are removed from `tools/list`, and calls to them are refused. This works with any client because it runs as a small stdio proxy.
- **Token cost**: `mcp-profile-switch cost frontend` shows the estimated tokens of every tool definition, and whether the profile shows or hides it.

No runtime dependencies. Requires Node 18 or later.

## Install

```sh
npm i -g mcp-profile-switch     # or use npx mcp-profile-switch ...
```

## 1. Write a profiles file

Put `mcp-profiles.json` in the project, or put a shared one at `~/.config/mcp-profile-switch/profiles.json`. You can also point `$MCP_PROFILES` or `--config` at another file.

```json
{
  "servers": {
    "github":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
    "linear":     { "type": "http", "url": "https://mcp.linear.app/mcp" }
  },
  "profiles": {
    "frontend": {
      "description": "Browser testing, read-only GitHub",
      "servers": ["playwright", "github"],
      "tools": {
        "playwright": ["browser_navigate", "browser_click", "browser_snapshot"],
        "github": ["get_*", "list_*", "search_*"]
      }
    },
    "backend": { "servers": ["github", "linear"] }
  }
}
```

- `servers` uses the same entries as a client config: `command`/`args`/`env`/`cwd` for stdio servers, or `url` (plus `type` and `headers`) for remote ones. The values are copied into the client file exactly as written.
- `profiles.<name>.servers` lists the servers the profile turns on.
- `profiles.<name>.tools.<server>` is an optional allowlist. `*` matches any run of characters. A server with no allowlist exposes all of its tools.

A full example is in [examples/mcp-profiles.json](examples/mcp-profiles.json).

## 2. Check what each tool costs

```sh
$ mcp-profile-switch cost frontend
playwright  (3/21 tools exposed, ~412 tokens)
  -    611  browser_run_code
  +    163  browser_click
  ...
  ! allowlist pattern "browser_snapshotz" matches no tool

github  (17/26 tools exposed, ~3,940 tokens)
  ...

Total exposed: ~4,352 tokens  (hidden by profile: ~6,180)
```

`+` means the profile exposes the tool and `-` means it hides it. Run `cost` with no profile name to see every server in the file. Add `--json` for machine-readable output. To get the numbers, the command starts each stdio server and asks it for its tool list. Remote servers are skipped.

Token counts are estimates: the length of the tool's JSON definition (name, description, input schema) divided by 4. They are good for ranking tools and comparing profiles, but they won't match any one tokenizer exactly.

## 3. Switch the project to a profile

```sh
mcp-profile-switch use frontend                    # writes ./.mcp.json (Claude Code)
mcp-profile-switch use frontend -t cursor -t vscode   # .cursor/mcp.json and .vscode/mcp.json
mcp-profile-switch list                            # show profiles
```

| target   | file               | key          |
| -------- | ------------------ | ------------ |
| `claude` | `.mcp.json`        | `mcpServers` |
| `cursor` | `.cursor/mcp.json` | `mcpServers` |
| `vscode` | `.vscode/mcp.json` | `servers`    |

The server map in the target file is **replaced** by the profile's servers. That is deliberate, so nothing outside the profile gets in. Other top-level keys, such as VS Code `inputs`, are kept. If the existing file has servers that your profiles file doesn't define, `use` stops and lists them, so a hand-written config is never lost by accident. Copy them into `servers`, or pass `--force` to drop them. After switching, restart or reload MCP in your client.

Note: this only controls project-scoped config. Servers you added at user scope (for example `claude mcp add -s user`) still load in every project. Move them into the profiles file if you want profiles to control them.

If a server has a tool allowlist, its entry is wrapped in the proxy:

```json
"playwright": {
  "command": "npx",
  "args": ["-y", "mcp-profile-switch", "proxy",
           "--allow", "browser_navigate", "--allow", "browser_click",
           "--", "npx", "-y", "@playwright/mcp@latest"]
}
```

The generated file doesn't depend on anything else, so it's safe to commit for your team. If the package is installed globally, use `--proxy-command mcp-profile-switch` to skip `npx` and start faster.

## The proxy on its own

```sh
mcp-profile-switch proxy --allow 'read_*' --allow list_dir -- npx -y @modelcontextprotocol/server-filesystem .
```

The proxy starts the server and passes newline-delimited JSON-RPC through in both directions, with two changes. `tools/list` results are trimmed to the allowlist, and a `tools/call` for a hidden tool gets a `-32602` error without ever reaching the server. Stderr and the exit code are passed through.

Limits: filtering only works for stdio servers. A profile that sets a tool allowlist on a remote (`url`) server is rejected, though remote servers without an allowlist work normally. Resources and prompts are not filtered.

## Library

```ts
import { loadConfig, buildServers, writeTarget, listTools, estimateTokens, createToolFilter } from "mcp-profile-switch";

const cfg = loadConfig("mcp-profiles.json");
writeTarget(process.cwd(), "claude", buildServers(cfg, "frontend"));
```

See [examples/cost-report.mjs](examples/cost-report.mjs) for a script that ranks a profile's tools by cost.

## Development

```sh
npm install
npm test        # compiles and runs node:test, no network
npm run lint    # type-check
npm run build   # emits dist/
```

## License

MIT
