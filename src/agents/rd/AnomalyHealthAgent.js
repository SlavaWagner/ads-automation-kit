import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

/**
 * Pure statistical Z-Score Anomaly Detector across daily campaign time-series.
 */
export function detectZScoreAnomalies(dailyRows = [], { zThreshold = 2.0 } = {}) {
  const byCamp = new Map();
  for (const r of dailyRows) {
    const cid = String(r.campaign?.id || '0');
    const date = r.segments?.date;
    if (!date) continue;
    if (!byCamp.has(cid)) byCamp.set(cid, { campaignId: cid, campaignName: r.campaign?.name || '-', days: [] });
    byCamp.get(cid).days.push({
      date,
      cost: fromMicros(r.metrics?.costMicros),
      clicks: Number(r.metrics?.clicks || 0),
      impressions: Number(r.metrics?.impressions || 0),
      conversions: Number(r.metrics?.conversions || 0)
    });
  }

  const calcStats = (arr) => {
    const n = arr.length;
    if (!n) return { mean: 0, std: 0 };
    const mean = arr.reduce((s, v) => s + v, 0) / n;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    return { mean, std: Math.sqrt(variance) };
  };

  const alerts = [];
  for (const camp of byCamp.values()) {
    camp.days.sort((a, b) => a.date.localeCompare(b.date));
    if (camp.days.length < 5) continue;

    const latest = camp.days[camp.days.length - 1];
    const baseline = camp.days.slice(0, -1);

    const costStats = calcStats(baseline.map((d) => d.cost));
    const convStats = calcStats(baseline.map((d) => d.conversions));

    if (costStats.std > 0) {
      const zCost = (latest.cost - costStats.mean) / costStats.std;
      if (Math.abs(zCost) >= zThreshold) {
        alerts.push({
          severity: Math.abs(zCost) >= 2.5 ? 'CRITICAL' : 'WARNING',
          campaignId: camp.campaignId,
          campaignName: camp.campaignName,
          date: latest.date,
          metric: 'SPEND',
          baselineMean: Number(costStats.mean.toFixed(2)),
          latestValue: Number(latest.cost.toFixed(2)),
          zScore: Number(zCost.toFixed(2)),
          direction: zCost > 0 ? 'SPIKE' : 'DROP'
        });
      }
    }

    if (convStats.mean >= 1.5 && latest.conversions === 0) {
      alerts.push({
        severity: 'CRITICAL',
        campaignId: camp.campaignId,
        campaignName: camp.campaignName,
        date: latest.date,
        metric: 'CONVERSIONS_OUTAGE',
        baselineMean: Number(convStats.mean.toFixed(2)),
        latestValue: 0,
        zScore: convStats.std > 0 ? Number(((-convStats.mean) / convStats.std).toFixed(2)) : -3.0,
        direction: 'ZERO_OUTAGE'
      });
    } else if (convStats.std > 0) {
      const zConv = (latest.conversions - convStats.mean) / convStats.std;
      if (zConv <= -zThreshold) {
        alerts.push({
          severity: Math.abs(zConv) >= 2.5 ? 'CRITICAL' : 'WARNING',
          campaignId: camp.campaignId,
          campaignName: camp.campaignName,
          date: latest.date,
          metric: 'CONVERSIONS',
          baselineMean: Number(convStats.mean.toFixed(2)),
          latestValue: Number(latest.conversions.toFixed(2)),
          zScore: Number(zConv.toFixed(2)),
          direction: 'DROP'
        });
      }
    }
  }

  return alerts.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
}

export class AnomalyHealthAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'rd-anomaly-health',
      name: 'R&D Account Health, Z-Score Anomaly & Self-Healing Agent',
      group: 'RD_INTELLIGENCE',
      sequence: 8,
      category: 'R&D Stage 8 — Account Health, Z-Score Anomaly & Self-Healing',
      description:
        'Runs statistical Z-Score anomaly detection (Spend spikes, Conversion drops/outages) correlated with Change History & Policy Diagnostics, and executes supervised self-healing interventions (pause runaway campaign or tighten Target CPA).',
      pairedTools: [
        'report_campaigns',
        'report_times',
        'report_change_history',
        'report_policy_diagnostics',
        'report_conversion_actions',
        'update_entity_status',
        'adjust_target_cpa'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);

    const [timeRes, chRes, polRes, convRes] = await Promise.all([
      this.invoke(registry, 'report_times', { date_range: 'LAST_30_DAYS', granularity: 'DATE', limit: 2000 }, ctx),
      this.invoke(registry, 'report_change_history', { mode: 'CHANGE_EVENT', days_back: 7, limit: 50 }, ctx).catch(() => ({ results: [] })),
      this.invoke(registry, 'report_policy_diagnostics', { limit: 50 }, ctx).catch(() => ({ disapprovedOrLimitedAds: [] })),
      this.invoke(registry, 'report_conversion_actions', { include_campaign_breakdown: false, limit: 50 }, ctx).catch(() => ({ results: [] }))
    ]);

    const alerts = detectZScoreAnomalies(timeRes.results || [], { zThreshold: 2.0 });
    const policyCount = (polRes.disapprovedOrLimitedAds || []).length;
    const recentChangesCount = (chRes.results || []).length;

    if (ctx.json) {
      console.log(JSON.stringify({ alerts, policyIssues: policyCount, recentChanges7d: recentChangesCount, activeConversionActions: (convRes.results || []).length }, null, 2));
      return { alerts, policyCount, recentChangesCount };
    }

    console.log(chalk.cyan(`Diagnostics Summary -> Policy Alerts: ${policyCount} | Recent 7d Changes: ${recentChangesCount} | Statistical Anomalies: ${alerts.length}\n`));

    this.printTable(
      ['Severity', 'Campaign', 'Date', 'Metric', 'Baseline/d', 'Latest', 'Z-Score', 'Signal'],
      alerts.map((a) => [
        a.severity,
        truncStr(a.campaignName, 24),
        a.date,
        a.metric,
        fmtNum(a.baselineMean),
        fmtNum(a.latestValue),
        a.zScore,
        a.direction
      ]),
      { title: 'Z-Score Account Health & Anomaly Monitor (|Z| >= 2.0)' }
    );

    this.saveArtifact({ alerts, policyCount, recentChangesCount }, ctx.nonInteractive);
    if (ctx.nonInteractive || !alerts.length) return { alerts, policyCount, recentChangesCount };

    const action = await select({
      message: 'Self-Healing Mitigation — choose action:',
      choices: [
        { name: '1) Emergency Pause an Anomalous Campaign (update_entity_status)', value: 'pause' },
        { name: '2) Tighten Target CPA by 15% on Spiking Campaign (adjust_target_cpa)', value: 'tcpa' },
        { name: 'Back to Main Menu', value: 'exit' }
      ]
    });

    if (action === 'pause') {
      const target = await select({
        message: 'Select anomalous campaign to PAUSE:',
        choices: alerts.map((a) => ({ name: `[${a.severity}] ${a.campaignName} (${a.metric} Z=${a.zScore})`, value: a }))
      });
      await this.mutate(
        registry,
        {
          toolName: 'update_entity_status',
          payload: { entity_type: 'CAMPAIGN', status: 'PAUSED', resource_names_or_ids: [target.campaignId] },
          summaryTitle: `Self-Heal Pause Campaign ${target.campaignId} (${target.metric})`,
          summaryLines: [`Campaign : ${target.campaignName}`, `Anomaly  : ${target.metric} (${target.direction}, Z=${target.zScore})`]
        },
        ctx
      );
    }
  }
}
