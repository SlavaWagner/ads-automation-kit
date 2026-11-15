import chalk from 'chalk';
import { select, input, confirm } from '@inquirer/prompts';
import { fromMicros, normalizeCustomerId } from '../googleAdsClient.js';
import { executeWithConfirmation } from '../safety.js';
import { generateText } from '../gemini.js';
import { saveAgentRunReport } from '../memory.js';

export function fmtMoney(val, currency = '') {
  const num = Number(val || 0);
  const formatted = num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

export function fmtMicros(micros, currency = '') {
  return fmtMoney(fromMicros(micros), currency);
}

export function fmtPct(decimalRatio, digits = 2) {
  const num = Number(decimalRatio || 0) * 100;
  return `${num.toFixed(digits)}%`;
}

export function fmtNum(val) {
  return Number(val || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function truncStr(str, maxLen = 36) {
  const s = String(str ?? '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 3))}...`;
}

/**
 * Base class for all 25 interactive CLI Agents (16 MCP Paired + 9 R&D Intelligence).
 */
export class BaseCliAgent {
  constructor({
    id,
    name,
    group = 'MCP_PAIRED',
    sequence = 0,
    category = 'General',
    description,
    pairedTools = []
  }) {
    this.id = id;
    this.name = name;
    this.group = group;
    this.sequence = sequence;
    this.category = category;
    this.description = description;
    this.pairedTools = pairedTools;
  }

  getSequenceTag() {
    const seqStr = String(this.sequence || 0).padStart(2, '0');
    return this.group === 'RD_INTELLIGENCE' ? `R&D ${seqStr}/09` : `MCP ${seqStr}/16`;
  }

  getDescriptor() {
    return {
      id: this.id,
      name: this.name,
      group: this.group,
      sequence: this.sequence,
      sequenceTag: this.getSequenceTag(),
      category: this.category,
      description: this.description,
      pairedTools: this.pairedTools
    };
  }

  printBanner(ctx = {}) {
    if (ctx.json) return;
    const seqTag = this.getSequenceTag();
    const badge =
      this.group === 'RD_INTELLIGENCE'
        ? chalk.bgMagenta.white.bold(` ${seqTag} `)
        : chalk.bgCyan.black.bold(` ${seqTag} `);
    console.log('\n' + chalk.gray('='.repeat(78)));
    console.log(`${badge}  ${chalk.bold.white(this.name)} ${chalk.gray(`(${this.id})`)}`);
    console.log(chalk.gray(`Category : ${this.category}`));
    console.log(chalk.white(`Purpose  : ${this.description}`));
    console.log(chalk.cyan(`Paired   : ${this.pairedTools.join(', ')}`));
    if (ctx.customerId) {
      console.log(chalk.yellow(`Account  : ${ctx.customerId}`));
    }
    console.log(chalk.gray('='.repeat(78)) + '\n');
  }

  async invoke(registry, toolName, args = {}, ctx = {}) {
    const payload = { ...args };
    if (ctx.customerId && !payload.customer_id) {
      payload.customer_id = normalizeCustomerId(ctx.customerId);
    }
    if (ctx.loginCustomerId && !payload.login_customer_id) {
      payload.login_customer_id = normalizeCustomerId(ctx.loginCustomerId);
    }
    return await registry.invoke(toolName, payload);
  }

  async mutate(registry, { toolName, payload, summaryTitle, summaryLines = [], baselineSnapshot = null }, ctx = {}) {
    const fullPayload = { ...payload };
    if (ctx.customerId && !fullPayload.customer_id) {
      fullPayload.customer_id = normalizeCustomerId(ctx.customerId);
    }
    if (ctx.loginCustomerId && !fullPayload.login_customer_id) {
      fullPayload.login_customer_id = normalizeCustomerId(ctx.loginCustomerId);
    }

    return await executeWithConfirmation({
      registry,
      agentId: this.id,
      toolName,
      payload: fullPayload,
      summaryTitle,
      summaryLines,
      baselineSnapshot,
      autoConfirm: Boolean(ctx.autoConfirm),
      dryRunOnly: Boolean(ctx.dryRunOnly)
    });
  }

  printTable(headers, rows, { maxRows = 30, title = null } = {}) {
    if (title) {
      console.log(chalk.bold.cyan(`\n${title}`));
    }
    if (!rows || !rows.length) {
      console.log(chalk.yellow('  (No matching records returned.)\n'));
      return;
    }

    const displayRows = rows.slice(0, maxRows).map((r) => r.map((cell) => String(cell ?? '')));
    const widths = headers.map((h, i) =>
      Math.max(
        String(h).length,
        ...displayRows.map((r) => String(r[i] ?? '').length)
      )
    );

    const headerLine = headers.map((h, i) => String(h).padEnd(widths[i])).join(' | ');
    const divider = widths.map((w) => '-'.repeat(w)).join('-+-');

    console.log(chalk.bold.white('  ' + headerLine));
    console.log(chalk.gray('  ' + divider));
    for (const row of displayRows) {
      console.log('  ' + row.map((cell, i) => String(cell).padEnd(widths[i])).join(' | '));
    }
    if (rows.length > maxRows) {
      console.log(chalk.gray(`  ... showing top ${maxRows} of ${rows.length} rows.`));
    }
    console.log('');
  }

  async pickDateRange(ctx = {}, defaultRange = 'LAST_30_DAYS') {
    if (ctx.dateRange) return ctx.dateRange;
    if (ctx.nonInteractive) return defaultRange;
    return await select({
      message: 'Select lookback date range:',
      choices: [
        { name: 'Last 7 Days', value: 'LAST_7_DAYS' },
        { name: 'Last 14 Days', value: 'LAST_14_DAYS' },
        { name: 'Last 30 Days (Recommended)', value: 'LAST_30_DAYS' },
        { name: 'This Month', value: 'THIS_MONTH' },
        { name: 'Last Month', value: 'LAST_MONTH' },
        { name: 'Yesterday', value: 'YESTERDAY' },
        { name: 'Today', value: 'TODAY' }
      ],
      default: defaultRange
    });
  }

  async pickCampaign(registry, ctx = {}, { allowAll = true, dateRange = 'LAST_30_DAYS', channelType = 'ALL' } = {}) {
    if (ctx.campaignId) return ctx.campaignId;
    if (ctx.nonInteractive) return allowAll ? undefined : null;

    let campaigns = [];
    try {
      const res = await this.invoke(
        registry,
        'report_campaigns',
        { date_range: dateRange, channel_type: channelType, limit: 100 },
        ctx
      );
      campaigns = res.results || [];
    } catch {
      campaigns = [];
    }

    if (!campaigns.length) {
      const manual = await input({
        message: allowAll ? 'Campaign ID (leave blank for all campaigns):' : 'Enter Campaign ID:',
        default: ''
      });
      return manual.trim() || undefined;
    }

    const choices = [];
    if (allowAll) {
      choices.push({ name: 'All Campaigns', value: '__ALL__' });
    }
    for (const row of campaigns) {
      const c = row.campaign || {};
      const m = row.computed || {};
      choices.push({
        name: `[${c.id}] ${truncStr(c.name, 34)} (${c.advertisingChannelType || 'SEARCH'}, ${c.status}, Spend: ${fmtMoney(m.cost)}, Conv: ${fmtNum(row.metrics?.conversions)})`,
        value: String(c.id)
      });
    }
    choices.push({ name: 'Enter Campaign ID manually...', value: '__MANUAL__' });

    const picked = await select({ message: 'Select target campaign:', choices });
    if (picked === '__ALL__') return undefined;
    if (picked === '__MANUAL__') {
      const manual = await input({ message: 'Campaign ID:' });
      return manual.trim() || undefined;
    }
    return picked;
  }

  async pickAdGroup(registry, ctx = {}, { campaignId, allowAll = false, dateRange = 'LAST_30_DAYS' } = {}) {
    if (ctx.adGroupId) return ctx.adGroupId;
    if (ctx.nonInteractive) return allowAll ? undefined : null;

    let adGroups = [];
    try {
      const res = await this.invoke(
        registry,
        'report_ad_groups',
        { date_range: dateRange, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 100 },
        ctx
      );
      adGroups = res.results || [];
    } catch {
      adGroups = [];
    }

    if (!adGroups.length) {
      const manual = await input({
        message: allowAll ? 'Ad Group ID (leave blank for all):' : 'Enter Ad Group ID:',
        default: ''
      });
      return manual.trim() || undefined;
    }

    const choices = [];
    if (allowAll) {
      choices.push({ name: 'All Ad Groups', value: '__ALL__' });
    }
    for (const row of adGroups) {
      const ag = row.adGroup || {};
      const c = row.campaign || {};
      choices.push({
        name: `[${ag.id}] ${truncStr(ag.name, 30)} | Camp: ${truncStr(c.name, 20)} (${ag.status})`,
        value: String(ag.id)
      });
    }
    choices.push({ name: 'Enter Ad Group ID manually...', value: '__MANUAL__' });

    const picked = await select({ message: 'Select target Ad Group:', choices });
    if (picked === '__ALL__') return undefined;
    if (picked === '__MANUAL__') {
      const manual = await input({ message: 'Ad Group ID:' });
      return manual.trim() || undefined;
    }
    return picked;
  }

  async offerAiAnalysis(contextData, instructions, defaultQuestion = 'Summarize top risks, wasted spend, and highest-ROI actions.') {
    const runAi = await confirm({
      message: 'Run AI Strategic Analysis on these findings (via Gemini API or Antigravity Bridge)?',
      default: false
    });
    if (!runAi) return null;

    const customQuestion = await input({
      message: 'Focus question for AI Analyst:',
      default: defaultQuestion
    });

    const response = await generateText({
      systemPrompt: `You are a Principal Google Ads Performance Strategist and API Automation Architect operating inside ads-automation-kit.\n${instructions}\nRespond concisely in English with prioritized, quantitative recommendations grounded strictly in the provided API data.`,
      userPrompt: `Question: ${customQuestion}\n\nGoogle Ads API Data:\n${JSON.stringify(contextData, null, 2).slice(0, 28000)}`
    });

    console.log(chalk.bold.green('\n--- AI STRATEGIC ANALYSIS ---'));
    console.log(response);
    console.log(chalk.bold.green('----------------------------\n'));
    return response;
  }

  saveArtifact(payload, quiet = false) {
    const outPath = saveAgentRunReport(this.id, payload);
    if (!quiet) {
      console.log(chalk.gray(`Saved run artifact -> ${outPath}`));
    }
    return outPath;
  }

  async run(_registry, _ctx = {}) {
    throw new Error(`Agent "${this.id}" must implement run(registry, ctx).`);
  }
}
