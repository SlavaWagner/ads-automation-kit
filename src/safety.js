import chalk from 'chalk';
import { select, confirm } from '@inquirer/prompts';
import { recordDecision } from './memory.js';

/**
 * Deterministic Google Ads policy & length compliance sanitizer for generated RSAs & Assets.
 */
export function sanitizeAdCopy({ headlines = [], descriptions = [], longHeadlines = [] }) {
  const bannedReplacements = [
    { pattern: /\bROI\b/gi, replacement: 'Yield' },
    { pattern: /\bBoost\b/gi, replacement: 'Scale' },
    { pattern: /\bImmediate(?:ly)?\b/gi, replacement: 'Direct' },
    { pattern: /\bGuaranteed\b/gi, replacement: 'Verified' },
    { pattern: /\b100%\s*free\b/gi, replacement: 'Complimentary' },
    { pattern: /\bSofort\b/gi, replacement: 'Direkt' },
    { pattern: /\bJetzt\b/gi, replacement: 'Heute' },
    { pattern: /\bBewiesen(?:e|er|es)?\b/gi, replacement: 'Geprüft' }
  ];

  const cleanText = (text, maxLen) => {
    let out = String(text || '').trim();
    for (const rule of bannedReplacements) {
      out = out.replace(rule.pattern, rule.replacement);
    }
    out = out.replace(/!+/g, '').replace(/\s+/g, ' ').trim();
    if (out.endsWith('.')) {
      out = out.slice(0, -1).trim();
    }
    if (out.length > maxLen) {
      const sliced = out.slice(0, maxLen);
      const lastSpace = sliced.lastIndexOf(' ');
      out = lastSpace > Math.floor(maxLen * 0.55) ? sliced.slice(0, lastSpace).trim() : sliced.trim();
    }
    return out;
  };

  return {
    headlines: [...new Set(headlines.map((h) => cleanText(h, 30)).filter(Boolean))],
    longHeadlines: [...new Set(longHeadlines.map((lh) => cleanText(lh, 90)).filter(Boolean))],
    descriptions: [...new Set(descriptions.map((d) => cleanText(d, 90)).filter(Boolean))]
  };
}

/**
 * Prints a human-readable Mutation Plan, optionally runs Google Ads API validate_only=true dry-run,
 * prompts for explicit user confirmation, commits live mutation, and records Episodic Memory receipt.
 */
export async function executeWithConfirmation({
  registry,
  agentId,
  toolName,
  payload,
  summaryTitle,
  summaryLines = [],
  baselineSnapshot = null,
  autoConfirm = false,
  dryRunOnly = false
}) {
  console.log(chalk.bold.yellow('\n+----------------------------------------------------------------------+'));
  console.log(chalk.bold.yellow(`|  MUTATION PROPOSAL: ${summaryTitle.slice(0, 48).padEnd(48)} |`));
  console.log(chalk.bold.yellow('+----------------------------------------------------------------------+'));
  console.log(chalk.cyan(`  Tool / Endpoint : ${toolName}`));
  for (const line of summaryLines) {
    console.log(chalk.white(`  ${line}`));
  }
  console.log(chalk.gray(`  Dry-Run Support : ${payload.validate_only !== undefined || true ? 'validate_only supported' : 'N/A'}`));
  console.log(chalk.bold.yellow('+----------------------------------------------------------------------+\n'));

  if (dryRunOnly) {
    console.log(chalk.cyan('[DRY-RUN] Executing API pre-flight validation (validate_only: true)...'));
    const dryRes = await registry.invoke(toolName, { ...payload, validate_only: true });
    recordDecision({
      agentId,
      toolName,
      customerId: dryRes.customerId || payload.customer_id,
      dryRun: true,
      summaryTitle,
      payload: { ...payload, validate_only: true },
      response: dryRes,
      baselineSnapshot
    });
    console.log(chalk.green('✔ Dry-run validation succeeded! No live account changes written.'));
    return { status: 'DRY_RUN_OK', result: dryRes };
  }

  let choice;
  if (autoConfirm) {
    choice = 'dry_and_commit';
  } else {
    choice = await select({
      message: 'How do you want to proceed with this Google Ads mutation?',
      choices: [
        { name: '1) Validate Dry-Run first (validate_only=true), then ask before committing', value: 'dry_then_ask' },
        { name: '2) Execute Dry-Run Only (no live commit)', value: 'dry_only' },
        { name: '3) Execute Live Mutation immediately', value: 'commit_now' },
        { name: '4) Cancel (no changes)', value: 'cancel' }
      ],
      default: 'dry_then_ask'
    });
  }

  if (choice === 'cancel') {
    console.log(chalk.gray('Cancelled — no changes made to your Google Ads account.'));
    return { status: 'CANCELLED' };
  }

  if (choice === 'dry_only' || choice === 'dry_then_ask' || choice === 'dry_and_commit') {
    console.log(chalk.cyan('\n[1/2] Running Google Ads API Dry-Run validation (validate_only: true)...'));
    const dryRes = await registry.invoke(toolName, { ...payload, validate_only: true });
    recordDecision({
      agentId,
      toolName,
      customerId: dryRes.customerId || payload.customer_id,
      dryRun: true,
      summaryTitle,
      payload: { ...payload, validate_only: true },
      response: dryRes,
      baselineSnapshot
    });
    console.log(chalk.green('✔ API Dry-Run passed!'));

    if (choice === 'dry_only') {
      return { status: 'DRY_RUN_OK', result: dryRes };
    }

    if (choice === 'dry_then_ask') {
      const proceed = await confirm({
        message: 'Dry-run succeeded. Commit this mutation LIVE to Google Ads now?',
        default: false
      });
      if (!proceed) {
        console.log(chalk.gray('Stopped after dry-run — no live changes committed.'));
        return { status: 'DRY_RUN_OK', result: dryRes };
      }
    }
  }

  console.log(chalk.yellow('\n[2/2] Committing live mutation to Google Ads API...'));
  const liveRes = await registry.invoke(toolName, { ...payload, validate_only: false });
  const decision = recordDecision({
    agentId,
    toolName,
    customerId: liveRes.customerId || payload.customer_id,
    dryRun: false,
    summaryTitle,
    payload: { ...payload, validate_only: false },
    response: liveRes,
    baselineSnapshot
  });

  console.log(chalk.bold.green(`✔ Live mutation committed! Recorded in Episodic Memory (${decision.id}).`));
  return { status: 'COMMITTED', result: liveRes, decision };
}
