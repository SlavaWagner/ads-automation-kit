import { z } from 'zod';
import { registerCoreTools } from './tools/coreTools.js';
import { registerResearchTools } from './tools/researchTools.js';
import { registerReportingTools } from './tools/reportingTools.js';
import { registerMutateTools } from './tools/mutateTools.js';

/**
 * Dual-purpose registry wrapping all 56 Google Ads MCP tools so BOTH:
 * 1) The Stdio MCP Server exposes them to Antigravity / external MCP clients, AND
 * 2) All 25 CLI Agents invoke the exact same zod-validated tool handlers in-process.
 */
export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  registerTool(name, definition, handler) {
    const schemaShape = definition.inputSchema || {};
    const zodValidator = z.object(schemaShape);
    const category = this.#inferCategory(name, definition);
    this.tools.set(name, {
      name,
      category,
      definition,
      zodValidator,
      handler
    });
  }

  #inferCategory(name, definition) {
    if (definition?.annotations?.readOnlyHint === false || !definition?.annotations?.readOnlyHint) {
      if (
        name.startsWith('create_') ||
        name.startsWith('adjust_') ||
        name.startsWith('update_') ||
        name.startsWith('exclude_') ||
        name.startsWith('attach_') ||
        name.startsWith('link_') ||
        name.startsWith('manage_') ||
        name.startsWith('upload_') ||
        name.startsWith('apply_')
      ) {
        return 'MUTATE';
      }
    }
    if (name.startsWith('report_')) return 'REPORT';
    if (
      name.startsWith('keyword_planner_') ||
      name.startsWith('suggest_') ||
      name.startsWith('search_audience_')
    ) {
      return 'RESEARCH';
    }
    return 'CORE';
  }

  has(name) {
    return this.tools.has(name);
  }

  get(name) {
    return this.tools.get(name);
  }

  list(category = 'ALL') {
    const all = Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      category: t.category,
      title: t.definition.title || t.name,
      description: t.definition.description || '',
      readOnly: t.category !== 'MUTATE'
    }));
    if (!category || category === 'ALL') return all;
    return all.filter((t) => t.category === category.toUpperCase());
  }

  /**
   * Validates inputs against the exact MCP tool zod schema and invokes the underlying handler.
   */
  async invoke(name, rawArgs = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown Google Ads MCP tool: "${name}"`);
    }
    const validatedArgs = tool.zodValidator.parse(rawArgs || {});
    const mcpResult = await tool.handler(validatedArgs);
    const textPayload = mcpResult?.content?.[0]?.text;
    let parsed;
    try {
      parsed = textPayload ? JSON.parse(textPayload) : mcpResult;
    } catch {
      parsed = { rawText: textPayload };
    }
    if (mcpResult?.isError || parsed?.error) {
      throw new Error(parsed?.message || `Tool "${name}" execution failed.`);
    }
    return parsed;
  }

  /**
   * Registers all 56 tools onto an @modelcontextprotocol/sdk McpServer instance.
   */
  attachToMcpServer(mcpServer) {
    for (const tool of this.tools.values()) {
      mcpServer.registerTool(tool.name, tool.definition, tool.handler);
    }
  }
}

export function createToolRegistry() {
  const registry = new ToolRegistry();
  registerCoreTools(registry);
  registerReportingTools(registry);
  registerResearchTools(registry);
  registerMutateTools(registry);
  return registry;
}
