// Minimal stdio MCP server used by tests. Exposes three tools, paginated over two pages.
import { createInterface } from "node:readline";

const tools = [
  { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "write_file", description: "Write a file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
  { name: "delete_everything", description: "Dangerous", inputSchema: { type: "object" } },
];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  } else if (msg.method === "tools/list") {
    const page2 = msg.params?.cursor === "p2";
    send({ id: msg.id, result: page2 ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: "p2" } });
  } else if (msg.method === "tools/call") {
    send({ id: msg.id, result: { content: [{ type: "text", text: `called ${msg.params.name}` }] } });
  }
});
