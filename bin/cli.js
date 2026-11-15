#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import chalk from 'chalk';
import { select, input, password, confirm } from '@inquirer/prompts';
import { enforceAntigravityRuntime } from '../src/guard.js';
import {
  PROJECT_ROOT,
  resolveConfigPath,
  resolveStorageDir,
  getConfig,
  saveConfig,
  refreshAccessToken
} from '../src/config.js';
import { runOAuthFlow } from '../src/auth.js';
import { apiGet, normalizeCustomerId } from '../src/googleAdsClient.js';
import { createToolRegistry } from '../src/mcp/toolRegistry.js';
import { createAgentRegistry } from '../src/agents/agentRegistry.js';
import { getDecisions, getTrackedChangeEvents } from '../src/memory.js';

const isMcpCmd = process.argv[2] === 'mcp';
enforceAntigravityRuntime(isMcpCmd ? 'mcp' : 'cli');

function getAgyMcpConfigPath() {
  return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
}

function maskSecret(val) {
  if (!val) return chalk.red('(not set)');
  if (val.length <= 8) return chalk.green('***' + val.slice(-2));
  return chalk.green(`${val.slice(0, 4)}...${val.slice(-4)}`);
}

function installIntoAntigravity({ dryRun = false } = {}) {
  const mcpConfigPath = getAgyMcpConfigPath();
  const serverEntryPath = path.resolve(PROJECT_ROOT, 'bin', 'mcp-server.js');
  const cfgPath = resolveConfigPath();

  let current = {};
  if (fs.existsSync(mcpConfigPath)) {
    const raw = fs.readFileSync(mcpConfigPath, 'utf8').trim();
    if (raw) current = JSON.parse(raw);
  }

  const next = {
    ...current,
    mcpServers: {
      ...(current.mcpServers || {}),
      'ads-automation-kit': {
        command: 'node',
        args: [serverEntryPath],
        env: {
          AGY_SESSION: '1',
          ADS_KIT_CONFIG: cfgPath
        }
      }
    }
  };

  if (dryRun) {
    console.log(chalk.cyan(`\n[Dry Run] Would write ${mcpConfigPath}:`));
    console.log(JSON.stringify(next, null, 2));
    return mcpConfigPath;
  }

  const dir = path.dirname(mcpConfigPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(mcpConfigPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return mcpConfigPath;
}

async function interactiveSetup() {
  const current = getConfig();
  const cfgPath = resolveConfigPath();
  console.log(chalk.bold.cyan('\n=== ads-automation-kit — Interactive Setup ==='));
  console.log(chalk.gray('Uses the exact config.json & port 8085 OAuth2 schema as SlavaWagner/ai-ads-pipeline.\n'));

  const customerId = await input({
    message: 'Default Google Ads Customer ID (10 digits, hyphens OK):',
    default: current.customerId || ''
  });

  const loginCustomerId = await input({
    message: 'Manager MCC Login Customer ID (optional):',
    default: current.loginCustomerId || ''
  });

  const developerToken = await input({
    message: 'Google Ads Developer Token:',
    default: current.developerToken || ''
  });

  const clientId = await input({
    message: 'Google Cloud OAuth2 Client ID:',
    default: current.clientId || ''
  });

  const clientSecret = await password({
    message: current.clientSecret
      ? 'Google Cloud OAuth2 Client Secret (leave blank to keep existing):'
      : 'Google Cloud OAuth2 Client Secret:',
    mask: '*'
  });

  const googleAdsVersion = await input({
    message: 'Google Ads REST API Version:',
    default: current.googleAdsVersion || 'v24'
  });

  const geminiKey = await password({
    message: `Gemini API Key ("antigravity" = Antigravity Bridge, current: ${current.geminiApiKey || 'antigravity'}, blank to keep):`,
    mask: '*'
  });

  const updated = {
    ...current,
    customerId: normalizeCustomerId(customerId),
    loginCustomerId: normalizeCustomerId(loginCustomerId),
    developerToken: developerToken.trim(),
    clientId: clientId.trim(),
    clientSecret: clientSecret ? clientSecret.trim() : current.clientSecret,
    googleAdsVersion: googleAdsVersion.trim() || 'v24',
    geminiApiKey: geminiKey ? geminiKey.trim() : (current.geminiApiKey || 'antigravity')
  };

  if (!saveConfig(updated)) {
    console.error(chalk.red(`Failed to write ${cfgPath}`));
    process.exit(1);
  }
  console.log(chalk.green(`\n✔ Credentials saved to ${cfgPath}`));

  const runAuthNow = await confirm({
    message: 'Launch browser OAuth2 login flow now (http://localhost:8085) to obtain refresh token?',
    default: !updated.refreshToken
  });

  if (runAuthNow) {
    await runOAuthFlow();
  }

  const registerMcp = await confirm({
    message: `Register ads-automation-kit MCP server in Antigravity (${getAgyMcpConfigPath()})?`,
    default: true
  });

  if (registerMcp) {
    const p = installIntoAntigravity();
    console.log(chalk.green(`✔ Registered in ${p}`));
    console.log(chalk.yellow('Start a new Antigravity session or reload MCP so the 56 tools appear.'));
  }
}

async function interactiveLauncher(toolRegistry, agentRegistry) {
  while (true) {
    const cfg = getConfig();
    const pairedAgents = agentRegistry.list('MCP_PAIRED');
    const rdAgents = agentRegistry.list('RD_INTELLIGENCE');
    const decisions = getDecisions(100);
    const trackedEvents = getTrackedChangeEvents(cfg.customerId || 'default');

    console.clear();
    console.log(chalk.bold.cyan('+============================================================================+'));
    console.log(chalk.bold.cyan('|  ADS AUTOMATION KIT — Antigravity CLI Agent Suite + 56-Tool Google Ads MCP  |'));
    console.log(chalk.bold.cyan('+============================================================================+'));
    console.log(
      chalk.gray(
        `  Account: ${cfg.customerId || '(not set)'} | API: ${cfg.googleAdsVersion} | Tools: ${toolRegistry.list().length} | Agents: ${pairedAgents.length} MCP + ${rdAgents.length} R&D | Memory Events: ${trackedEvents.length} | Decisions: ${decisions.length}\n`
      )
    );

    const section = await select({
      message: 'Main Menu — choose workspace:',
      choices: [
        { name: `1) Launch Paired MCP Domain Agent (${pairedAgents.length} Sequential Agents — 1:1 with all 56 MCP APIs)`, value: 'mcp_agents' },
        { name: `2) Launch R&D Intelligence Agent (${rdAgents.length}-Stage Sequential Optimization Loop)`, value: 'rd_agents' },
        { name: '3) Start Continuous Change History Event Listener (--watch)', value: 'watch' },
        { name: '4) Inspect Episodic Memory & Mutation Decision Log', value: 'memory' },
        { name: '5) Direct 56-Tool MCP Inventory & Execution Inspector', value: 'tools' },
        { name: '6) Setup / OAuth2 Auth / Status Diagnostics', value: 'settings' },
        { name: 'Exit', value: 'exit' }
      ]
    });

    if (section === 'exit') {
      console.log(chalk.gray('Goodbye!'));
      break;
    }

    if (section === 'mcp_agents') {
      const id = await select({
        message: 'Select Paired MCP Domain Agent (01-16):',
        pageSize: 18,
        choices: [
          ...pairedAgents.map((a) => ({
            name: `[${String(a.sequence).padStart(2, '0')}/16] ${a.id.padEnd(24)} | ${a.name} (${a.pairedTools.length} tools)`,
            value: a.id
          })),
          { name: 'Back to Main Menu', value: '__BACK__' }
        ]
      });
      if (id !== '__BACK__') {
        await agentRegistry.get(id).run(toolRegistry, { customerId: cfg.customerId, loginCustomerId: cfg.loginCustomerId });
        await input({ message: 'Press Enter to return to Main Menu...', default: '' });
      }
    }

    if (section === 'rd_agents') {
      const id = await select({
        message: 'Select R&D Intelligence Stage Agent (Stage 1-9):',
        pageSize: 12,
        choices: [
          ...rdAgents.map((a) => ({
            name: `[Stage ${String(a.sequence).padStart(2, '0')}/09] ${a.id.padEnd(22)} | ${a.name}`,
            value: a.id
          })),
          { name: 'Back to Main Menu', value: '__BACK__' }
        ]
      });
      if (id !== '__BACK__') {
        await agentRegistry.get(id).run(toolRegistry, { customerId: cfg.customerId, loginCustomerId: cfg.loginCustomerId });
        await input({ message: 'Press Enter to return to Main Menu...', default: '' });
      }
    }

    if (section === 'watch') {
      await agentRegistry.get('change-history-listener').run(toolRegistry, {
        customerId: cfg.customerId,
        loginCustomerId: cfg.loginCustomerId,
        watch: true,
        intervalSec: 60
      });
    }

    if (section === 'memory') {
      console.log(chalk.bold.cyan(`\nEpisodic Memory Directory: ${path.join(resolveStorageDir(), 'memory')}`));
      console.log(chalk.white(`Tracked Change Events (${cfg.customerId || 'default'}): ${trackedEvents.length}`));
      console.log(chalk.white(`Recorded Decision Receipts: ${decisions.length}\n`));
      if (decisions.length) {
        console.log(JSON.stringify(decisions.slice(0, 10), null, 2));
      }
      await input({ message: 'Press Enter to continue...', default: '' });
    }

    if (section === 'tools') {
      const allTools = toolRegistry.list();
      const toolName = await select({
        message: `Select from ${allTools.length} Registered Google Ads MCP Tools:`,
        pageSize: 20,
        choices: [
          ...allTools.map((t) => ({ name: `[${t.category.padEnd(8)}] ${t.name.padEnd(34)} ${t.title}`, value: t.name })),
          { name: 'Back', value: '__BACK__' }
        ]
      });
      if (toolName !== '__BACK__') {
        const rawJson = await input({ message: `JSON arguments for ${toolName}:`, default: '{}' });
        try {
          const args = JSON.parse(rawJson || '{}');
          const res = await toolRegistry.invoke(toolName, args);
          console.log(JSON.stringify(res, null, 2));
        } catch (err) {
          console.error(chalk.red(`Error: ${err.message}`));
        }
        await input({ message: 'Press Enter to continue...', default: '' });
      }
    }

    if (section === 'settings') {
      const sub = await select({
        message: 'Setup & Diagnostics:',
        choices: [
          { name: 'Interactive Setup Wizard (Credentials + OAuth2 + Antigravity MCP)', value: 'setup' },
          { name: 'Re-run OAuth2 Browser Consent (Port 8085)', value: 'auth' },
          { name: 'Register MCP Server in Antigravity (~/.gemini/config/mcp_config.json)', value: 'install' },
          { name: 'Back', value: '__BACK__' }
        ]
      });
      if (sub === 'setup') await interactiveSetup();
      else if (sub === 'auth') await runOAuthFlow();
      else if (sub === 'install') {
        const p = installIntoAntigravity();
        console.log(chalk.green(`✔ Registered in ${p}`));
      }
      if (sub !== '__BACK__') {
        await input({ message: 'Press Enter to continue...', default: '' });
      }
    }
  }
}

const program = new Command();

program
  .name('ads-automation-kit')
  .description(
    'Unofficial Google Ads Automation Kit & MCP Server (Built with Antigravity CLI) pairing 56 Google Ads API tools with 25 dedicated interactive CLI Agents.'
  )
  .version('1.0.0')
  .option('--inside-agy', 'Flag confirming execution inside Google Antigravity CLI')
  .option('--force', 'Bypass Antigravity environment variable check');

program
  .command('setup')
  .description('Configure Google Ads API credentials, run port 8085 OAuth2 flow, and register MCP in Antigravity')
  .action(async () => {
    await interactiveSetup();
  });

program
  .command('auth')
  .description('Run OAuth2 loopback authorization flow on port 8085')
  .action(async () => {
    await runOAuthFlow();
  });

program
  .command('refresh-token')
  .description('Refresh OAuth2 access token non-interactively using stored refreshToken')
  .action(async () => {
    await refreshAccessToken();
    console.log(chalk.green('✔ OAuth2 access token refreshed and saved.'));
  });

program
  .command('config-import <sourcePath>')
  .description('Import existing config.json from SlavaWagner/ai-ads-pipeline or swa-google-ads-mcp')
  .action((sourcePath) => {
    const absSrc = path.resolve(sourcePath);
    if (!fs.existsSync(absSrc)) {
      console.error(chalk.red(`Source config file not found: ${absSrc}`));
      process.exit(1);
    }
    const imported = JSON.parse(fs.readFileSync(absSrc, 'utf8'));
    saveConfig({ ...getConfig(), ...imported });
    console.log(chalk.green(`✔ Imported configuration from ${absSrc} -> ${resolveConfigPath()}`));
  });

program
  .command('status')
  .alias('doctor')
  .description('Inspect config.json, OAuth2 token status, MCP registration, Episodic Memory, and optional live API check')
  .option('--live', 'Run live customers:listAccessibleCustomers check')
  .action(async (opts) => {
    const cfg = getConfig();
    const cfgPath = resolveConfigPath();
    const mcpConfigPath = getAgyMcpConfigPath();
    const toolReg = createToolRegistry();
    const agentReg = createAgentRegistry();

    let isRegistered = false;
    try {
      if (fs.existsSync(mcpConfigPath)) {
        const parsed = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8') || '{}');
        isRegistered = Boolean(parsed?.mcpServers?.['ads-automation-kit']);
      }
    } catch {
      isRegistered = false;
    }

    const tokenRemainingSec = cfg.tokenExpiry ? Math.round((cfg.tokenExpiry - Date.now()) / 1000) : 0;

    console.log(chalk.bold.cyan('\n=== ads-automation-kit Diagnostics ===\n'));
    console.log(`Config File:       ${cfgPath} ${fs.existsSync(cfgPath) ? chalk.green('(exists)') : chalk.yellow('(missing)')}`);
    console.log(`Storage Dir:       ${resolveStorageDir()}`);
    console.log(`API Version:       ${chalk.white(cfg.googleAdsVersion || 'v24')}`);
    console.log(`Customer ID:       ${cfg.customerId ? chalk.green(cfg.customerId) : chalk.yellow('(not set)')}`);
    console.log(`Login Customer ID: ${cfg.loginCustomerId ? chalk.green(cfg.loginCustomerId) : chalk.gray('(none)')}`);
    console.log(`Developer Token:   ${maskSecret(cfg.developerToken)}`);
    console.log(`OAuth Client ID:   ${maskSecret(cfg.clientId)}`);
    console.log(`Refresh Token:     ${maskSecret(cfg.refreshToken)}`);
    console.log(
      `Access Token:      ${cfg.accessToken ? (tokenRemainingSec > 0 ? chalk.green(`valid (${tokenRemainingSec}s left)`) : chalk.yellow('expired (auto-refreshes)')) : chalk.gray('(none yet)')}`
    );
    console.log(`Registered Tools:  ${chalk.green(toolReg.list().length)} Google Ads MCP Tools`);
    console.log(`CLI Agents:        ${chalk.green(agentReg.list('MCP_PAIRED').length)} MCP Paired + ${chalk.magenta(agentReg.list('RD_INTELLIGENCE').length)} R&D Intelligence`);
    console.log(`Antigravity MCP:   ${isRegistered ? chalk.green('Registered') : chalk.yellow('Not registered (run install-agy)')}`);

    if (opts.live) {
      console.log(chalk.cyan('\nTesting Google Ads API connectivity...'));
      try {
        const res = await apiGet('customers:listAccessibleCustomers', {}, 'doctor');
        console.log(chalk.green(`✔ Connected! Accessible customers (${(res.resourceNames || []).length}):`));
        (res.resourceNames || []).forEach((rn) => console.log(`  - ${rn}`));
      } catch (err) {
        console.error(chalk.red(`✖ API test failed: ${err.message}`));
        process.exitCode = 1;
      }
    }
    console.log('');
  });

program
  .command('agents')
  .description('List all 25 CLI Agents (16 MCP Paired + 9 R&D Intelligence) in sequential workflow order')
  .option('--group <group>', 'Filter by ALL, MCP_PAIRED, or RD_INTELLIGENCE', 'ALL')
  .option('--json', 'Output JSON')
  .action((opts) => {
    const reg = createAgentRegistry();
    const list = reg.list(opts.group).map((a) => a.getDescriptor());
    if (opts.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    console.log(chalk.bold.cyan(`\n=== Registered CLI Agents (${list.length}) ===\n`));
    for (const a of list) {
      const seqLabel = `[${a.sequenceTag}]`;
      const badge = a.group === 'RD_INTELLIGENCE' ? chalk.magenta(seqLabel) : chalk.cyan(seqLabel);
      console.log(`${badge} ${chalk.bold.white(a.id.padEnd(25))} ${chalk.white(a.name)}`);
      console.log(`            ${chalk.gray('Tools:')} ${chalk.green(a.pairedTools.join(', '))}`);
    }
    console.log('');
  });

program
  .command('run <agentId>')
  .description('Run any of the 25 CLI Agents directly by ID')
  .option('-c, --customer-id <id>', 'Override Google Ads Customer ID')
  .option('-d, --date-range <range>', 'Date range macro (TODAY, YESTERDAY, LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS)')
  .option('--campaign-id <id>', 'Pre-filter by Campaign ID')
  .option('--non-interactive', 'Run non-interactive report/analysis step only')
  .option('--json', 'Output JSON report')
  .option('--dry-run', 'Force validate_only=true for any mutate step')
  .action(async (agentId, opts) => {
    const toolReg = createToolRegistry();
    const agentReg = createAgentRegistry();
    const agent = agentReg.get(agentId);
    if (!agent) {
      console.error(chalk.red(`Unknown agent "${agentId}". Run "ads-automation-kit agents" to see valid IDs.`));
      process.exit(1);
    }
    const cfg = getConfig();
    await agent.run(toolReg, {
      customerId: normalizeCustomerId(opts.customerId || cfg.customerId),
      loginCustomerId: cfg.loginCustomerId,
      dateRange: opts.dateRange,
      campaignId: opts.campaignId,
      nonInteractive: Boolean(opts.nonInteractive || opts.json),
      json: Boolean(opts.json),
      dryRunOnly: Boolean(opts.dryRun)
    });
  });

program
  .command('watch-changes')
  .description('Start continuous Google Ads Change History Event Listener loop')
  .option('-c, --customer-id <id>', 'Target Customer ID')
  .option('-i, --interval <seconds>', 'Polling interval in seconds (min 15)', '60')
  .action(async (opts) => {
    const toolReg = createToolRegistry();
    const agentReg = createAgentRegistry();
    const cfg = getConfig();
    await agentReg.get('change-history-listener').run(toolReg, {
      customerId: normalizeCustomerId(opts.customerId || cfg.customerId),
      loginCustomerId: cfg.loginCustomerId,
      watch: true,
      intervalSec: Number(opts.interval || 60)
    });
  });

program
  .command('tools')
  .description('List all 56 registered Google Ads MCP tools')
  .option('--category <cat>', 'Filter by ALL, CORE, REPORT, RESEARCH, or MUTATE', 'ALL')
  .option('--json', 'Output JSON')
  .action((opts) => {
    const reg = createToolRegistry();
    const list = reg.list(opts.category);
    if (opts.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    console.log(chalk.bold.cyan(`\n=== Google Ads MCP Tools (${list.length}) ===\n`));
    list.forEach((t, idx) => {
      const num = String(idx + 1).padStart(2, '0');
      const tag = t.category === 'MUTATE' ? chalk.magenta(`[${num} MUTATE]  `) : chalk.blue(`[${num} ${t.category}]`.padEnd(13));
      console.log(`${tag} ${chalk.bold.white(t.name.padEnd(34))} ${chalk.gray(t.title)}`);
    });
    console.log('');
  });

program
  .command('call <toolName>')
  .description('Invoke any of the 56 Google Ads MCP tools directly with JSON args')
  .option('-a, --args <json>', 'JSON object payload', '{}')
  .option('--validate-only', 'Inject validate_only: true if supported')
  .action(async (toolName, opts) => {
    const reg = createToolRegistry();
    const args = JSON.parse(opts.args || '{}');
    if (opts.validateOnly) args.validate_only = true;
    const res = await reg.invoke(toolName, args);
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command('mcp')
  .description('Start the Stdio Model Context Protocol (MCP) server exposing all 56 tools')
  .action(async () => {
    await import('./mcp-server.js');
  });

program
  .command('install-agy')
  .description('Register ads-automation-kit MCP server in ~/.gemini/config/mcp_config.json')
  .option('--dry-run', 'Preview mcp_config.json without writing')
  .action((opts) => {
    const outPath = installIntoAntigravity({ dryRun: Boolean(opts.dryRun) });
    if (!opts.dryRun) {
      console.log(chalk.green(`✔ Registered ads-automation-kit in ${outPath}`));
    }
  });

program
  .command('uninstall-agy')
  .description('Remove ads-automation-kit from ~/.gemini/config/mcp_config.json')
  .action(() => {
    const mcpConfigPath = getAgyMcpConfigPath();
    if (!fs.existsSync(mcpConfigPath)) {
      console.log(chalk.yellow('No mcp_config.json found.'));
      return;
    }
    const json = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8') || '{}');
    if (json.mcpServers?.['ads-automation-kit']) {
      delete json.mcpServers['ads-automation-kit'];
      fs.writeFileSync(mcpConfigPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
      console.log(chalk.green(`✔ Removed ads-automation-kit from ${mcpConfigPath}`));
    } else {
      console.log(chalk.yellow('ads-automation-kit is not currently registered.'));
    }
  });

program
  .action(async () => {
    const toolReg = createToolRegistry();
    const agentReg = createAgentRegistry();
    await interactiveLauncher(toolReg, agentReg);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}`));
  process.exit(1);
});
