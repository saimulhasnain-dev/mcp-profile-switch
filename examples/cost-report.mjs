// Programmatic use: rank every tool of a profile by token cost.
// Usage (from this repo, after `npm run build`; the package imports itself by name):
//   node examples/cost-report.mjs examples/mcp-profiles.json frontend
// Note: this starts the profile's servers, and the example servers use npx, which downloads them.
import { estimateTokens, getProfile, isStdio, listTools, loadConfig, matchTool } from "mcp-profile-switch";

const [configPath = "mcp-profiles.json", profileName = "frontend"] = process.argv.slice(2);
const cfg = loadConfig(configPath);
const profile = getProfile(cfg, profileName);

const rows = [];
for (const name of profile.servers) {
  const server = cfg.servers[name];
  if (!isStdio(server)) continue;
  const allow = profile.tools?.[name];
  for (const tool of await listTools(server)) {
    if (!allow || matchTool(tool.name, allow)) rows.push({ server: name, tool: tool.name, tokens: estimateTokens(tool) });
  }
}

rows.sort((a, b) => b.tokens - a.tokens);
console.table(rows);
console.log(`Profile "${profileName}" costs ~${rows.reduce((s, r) => s + r.tokens, 0)} tokens of tool definitions.`);
