// `laneboard mcp`: stdio MCP server. stdout belongs to the protocol; nothing here prints (C4).
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, mcpRules, TOOL_LIST, toolListing } from './tools.ts';
import type { ToolEnv } from './tools.ts';

// Package version (same relative path from src/mcp and dist/mcp).
function packageVersion(): string {
  return (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

// Build the server: instructions = the MCP preamble and the MCP forms of the agent rules (mcpRules), tools from TOOL_LIST.
// The low-level Server is used on purpose: McpServer validates arguments itself and answers with plain text
// ("Input validation error"), which would lose the error object with `fix` that the CLI returns.
export function createMcpServer(env: ToolEnv): Server {
  const server = new Server({ name: 'laneboard', version: packageVersion() }, { capabilities: { tools: {} }, instructions: mcpRules() });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_LIST.map((t) => toolListing(t.def)) }));
  // The client's clientInfo.name (initialize) lets a fix name that client's way to a board (C-U1 run 2).
  server.setRequestHandler(CallToolRequestSchema, (request) => callTool(request.params.name, request.params.arguments, { ...env, client: server.getClientVersion()?.name }));
  return server;
}

// Serve over stdin/stdout until stdin ends or the transport closes.
export async function serveMcp(env: ToolEnv): Promise<void> {
  const server = createMcpServer(env);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => void server.close());
  await closed;
}
