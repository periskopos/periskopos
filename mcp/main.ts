import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PeriskoposClient } from "./client.ts";
import { createMcpServer } from "./server.ts";

// npm run mcp: speaks MCP over stdio, so stdout belongs to the protocol:
// anything meant for a person goes to stderr.
try {
  const server = createMcpServer(PeriskoposClient.fromEnv());
  await server.connect(new StdioServerTransport());
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
