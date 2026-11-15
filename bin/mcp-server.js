#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { enforceAntigravityRuntime } from '../src/guard.js';
import { createAdsAutomationMcpServer } from '../src/mcp/server.js';

enforceAntigravityRuntime('mcp');

export async function startMcpStdioServer() {
  const { server } = createAdsAutomationMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startMcpStdioServer().catch((err) => {
  console.error('[ads-automation-kit] Fatal MCP Server error:', err.message);
  process.exit(1);
});
