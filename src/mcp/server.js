import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createToolRegistry } from './toolRegistry.js';

export function createAdsAutomationMcpServer() {
  const server = new McpServer({
    name: 'ads-automation-kit',
    version: '1.0.0'
  });

  const registry = createToolRegistry();
  registry.attachToMcpServer(server);

  return { server, registry };
}
