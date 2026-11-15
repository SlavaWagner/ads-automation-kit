import chalk from 'chalk';
import { select, input } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

/**
 * Pure deterministic Micro-Step Budget Scaling & Volatility Circuit Breaker planner.
 */
export function planMicroStepScaling(campaignRows = [], isRows = [], dailyTimeRows = [], { targetCpaCeiling = 0, minRoasFloor = 0 } = {}) {
  const isMap = new Map((isRows || []).map((r) => [String(r.campaign?.id), r.metrics || {}]));
  const dailyConvByCamp = new Map();
  for (const r of dailyTimeRows || []) {
    const cid = String(r.campaign?.id || '');
    if (!dailyConvByCamp.has(cid)) dailyConvByCamp.set(cid, []);
    dailyConvByCamp.get(cid).push(Number(r.metrics?.conversions || 0));
  }

  const recommendations = [];
  for (const row of campaignRows) {
    const c = row.campaign || {};
    if (c.status !== 'ENABLED') continue;
    const cid = String(c.id);
    const budgetRn = c.campaignBudget || '';
    const budgetId = budgetRn.split('/').pop();
    const currentBudget = row.computed?.budgetDaily ?? fromMicros(row.campaignBudget?.amountMicros);
    const cost = row.computed?.cost ?? fromMicros(row.metrics?.costMicros);
    const conv = Number(row.metrics?.conversions || 0);
    const cpa = conv > 0 ? cost / conv : Infinity;
    const roas = row.computed?.roas ?? (cost > 0 ? Number(row.metrics?.conversionsValue || 0) / cost : 0);

    const ism = isMap.get(cid) || {};
    const budgetLostIs = Number(ism.searchBudgetLostImpressionShare || 0);

    // Volatility Circuit Breaker: Coefficient of Variation of daily conversions
    const series = dailyConvByCamp.get(cid) || [];
    let cv = 0;
    if (series.length >= 5) {
      const mean = series.reduce((s, v) => s + v, 0) / series.length;
      const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length;
      cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    }

    const cpaOk = targetCpaCeiling > 0 ? cpa <= targetCpaCeiling : conv >= 2;
    const roasOk = minRoasFloor > 0 ? roas >= minRoasFloor : true;

    let action = 'HOLD';
    let proposedBudget = currentBudget;
    let reason = 'Within stable operating corridor.';

    if (cv > 1.25 && conv < 10) {
      action = 'VOLATILITY_FREEZE';
      reason = `High daily conversion volatility (CV=${cv.toFixed(2)}); wait before scaling.`;
    } else if (budgetLostIs >= 0.15 && cpaOk && roasOk && conv >= 2) {
      action = 'SCALE_UP_15PCT';
      proposedBudget = Number((currentBudget * 1.15).toFixed(2));
      reason = `Budget Lost IS ${(budgetLostIs * 100).toFixed(0)}% with healthy CPA/ROAS -> safe +15% micro-step.`;
    } else if ((targetCpaCeiling > 0 && cpa > targetCpaCeiling * 1.35) || (cost >= 100 && conv === 0)) {
      action = 'DEFENSIVE_CUT_20PCT';
      proposedBudget = Math.max(5, Number((currentBudget * 0.8).toFixed(2)));
      reason = `Unprofitable CPA/spend (${fmtMoney(cost)} spent, ${conv} conv) -> -20% defensive trim.`;
    }

    recommendations.push({
      campaignId: cid,
      campaignName: c.name || '-',
      budgetId,
      currentBudget,
      proposedBudget,
      cost,
      conversions: conv,
      cpa: cpa === Infinity ? 0 : Number(cpa.toFixed(2)),
      roas,
      budgetLostIs,
      cv: Number(cv.toFixed(2)),
      action,
      reason
    });
  }

  return recommendations;
}

export class BudgetScalingAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'rd-budget-scaling',
      name: 'R&D Micro-Step Budget Scaling & Circuit Breaker Agent',
      group: 'RD_INTELLIGENCE',
      sequence: 6,
      category: 'R&D Stage 6 — Micro-Step Budget Scaling & Circuit Breaker',
      description:
        'Evaluates Budget Lost Impression Share, ROAS/CPA guardrails, and daily conversion Volatility Circuit Breakers; calculates safe +15% Micro-Step scale-ups or -20% defensive trims and applies via create_budget_and_adjust_bidding.',
      pairedTools: [
        'report_campaigns',
        'report_budgets_and_bidding',
        'report_impression_share',
        'report_times',
        'create_budget_and_adjust_bidding',
        'adjust_target_cpa',
        'adjust_target_roas',
        'update_entity_status'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [campRes, isRes, timeRes] = await Promise.all([
      this.invoke(registry, 'report_campaigns', { date_range: dateRange, statuses: ['ENABLED'], limit: 150 }, ctx),
      this.invoke(registry, 'report_impression_share', { date_range: dateRange, level: 'CAMPAIGN', limit: 150 }, ctx).catch(() => ({ results: [] })),
      this.invoke(registry, 'report_times', { date_range: 'LAST_14_DAYS', granularity: 'DATE', limit: 1000 }, ctx).catch(() => ({ results: [] }))
    ]);

    const cpaCap = ctx.nonInteractive ? 0 : Number(await input({ message: 'Optional Max Acceptable CPA ceiling (0 for auto):', default: '0' }));
    const plan = planMicroStepScaling(campRes.results || [], isRes.results || [], timeRes.results || [], { targetCpaCeiling: cpaCap });

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, scalingPlan: plan }, null, 2));
      return { dateRange, scalingPlan: plan };
    }

    this.printTable(
      ['Camp ID', 'Campaign', 'Action', 'Cur Bgt/d', 'New Bgt/d', 'Conv', 'CPA', 'Lost Bgt IS', 'Reason'],
      plan.map((p) => [
        p.campaignId,
        truncStr(p.campaignName, 22),
        p.action,
        fmtMoney(p.currentBudget),
        fmtMoney(p.proposedBudget),
        fmtNum(p.conversions),
        fmtMoney(p.cpa),
        fmtPct(p.budgetLostIs, 0),
        truncStr(p.reason, 36)
      ]),
      { title: `Micro-Step Budget Scaling & Circuit Breaker Plan (${dateRange})` }
    );

    this.saveArtifact({ dateRange, scalingPlan: plan }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, scalingPlan: plan };

    const actionable = plan.filter((p) => p.action === 'SCALE_UP_15PCT' || p.action === 'DEFENSIVE_CUT_20PCT');
    if (!actionable.length) {
      console.log(chalk.cyan('✔ All enabled campaigns are currently in HOLD / VOLATILITY_FREEZE equilibrium.\n'));
      return;
    }

    const picked = await select({
      message: 'Execute a proposed Micro-Step Budget Mutation?',
      choices: [
        ...actionable.map((p) => ({
          name: `[${p.action}] ${p.campaignName}: ${fmtMoney(p.currentBudget)} -> ${fmtMoney(p.proposedBudget)}/day`,
          value: p
        })),
        { name: 'Skip / Back to Main Menu', value: null }
      ]
    });

    if (picked && picked.budgetId) {
      await this.mutate(
        registry,
        {
          toolName: 'create_budget_and_adjust_bidding',
          payload: { action: 'UPDATE_BUDGET', budget_id: picked.budgetId, daily_budget: picked.proposedBudget },
          summaryTitle: `${picked.action}: ${picked.campaignName}`,
          summaryLines: [
            `Budget ID   : ${picked.budgetId}`,
            `Old Daily   : ${fmtMoney(picked.currentBudget)}`,
            `New Daily   : ${fmtMoney(picked.proposedBudget)}`,
            `Rationale   : ${picked.reason}`
          ],
          baselineSnapshot: { currentBudget: picked.currentBudget, cpa: picked.cpa }
        },
        ctx
      );
    }
  }
}
