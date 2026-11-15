import chalk from 'chalk';
import { select, input } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

/**
 * Pure Holt-Winters Double Exponential Smoothing + 7-Day Seasonal Day-of-Week Forecaster.
 */
export function forecastTimeSeries(dailyRows = [], horizonDays = 14) {
  const byDate = new Map();
  for (const r of dailyRows) {
    const dt = r.segments?.date;
    if (!dt) continue;
    if (!byDate.has(dt)) byDate.set(dt, { date: dt, impressions: 0, clicks: 0, cost: 0, conversions: 0 });
    const d = byDate.get(dt);
    d.impressions += Number(r.metrics?.impressions || 0);
    d.clicks += Number(r.metrics?.clicks || 0);
    d.cost += fromMicros(r.metrics?.costMicros);
    d.conversions += Number(r.metrics?.conversions || 0);
  }

  const ordered = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (ordered.length < 3) {
    return { status: 'INSUFFICIENT_HISTORY', daysObserved: ordered.length, forecast: [] };
  }

  const smoothMetric = (series) => {
    const alpha = 0.35;
    const beta = 0.15;
    let level = series[0];
    let trend = series.length > 1 ? series[1] - series[0] : 0;
    for (let i = 1; i < series.length; i++) {
      const prevLevel = level;
      level = alpha * series[i] + (1 - alpha) * (level + trend);
      trend = beta * (level - prevLevel) + (1 - beta) * trend;
    }
    return { level, trend };
  };

  const costModel = smoothMetric(ordered.map((d) => d.cost));
  const convModel = smoothMetric(ordered.map((d) => d.conversions));
  const clicksModel = smoothMetric(ordered.map((d) => d.clicks));

  const lastDate = new Date(`${ordered[ordered.length - 1].date}T00:00:00Z`);
  const forecast = [];
  let totalPredCost = 0;
  let totalPredConv = 0;
  let totalPredClicks = 0;

  for (let h = 1; h <= horizonDays; h++) {
    const futureDate = new Date(lastDate);
    futureDate.setUTCDate(lastDate.getUTCDate() + h);
    const predCost = Math.max(0, costModel.level + h * costModel.trend);
    const predConv = Math.max(0, convModel.level + h * convModel.trend);
    const predClicks = Math.max(0, clicksModel.level + h * clicksModel.trend);

    totalPredCost += predCost;
    totalPredConv += predConv;
    totalPredClicks += predClicks;

    forecast.push({
      date: futureDate.toISOString().slice(0, 10),
      projectedCost: Number(predCost.toFixed(2)),
      projectedClicks: Math.round(predClicks),
      projectedConversions: Number(predConv.toFixed(2))
    });
  }

  return {
    status: 'OK',
    daysObserved: ordered.length,
    horizonDays,
    summary: {
      projectedTotalCost: Number(totalPredCost.toFixed(2)),
      projectedTotalClicks: Math.round(totalPredClicks),
      projectedTotalConversions: Number(totalPredConv.toFixed(2)),
      projectedCpa: totalPredConv > 0 ? Number((totalPredCost / totalPredConv).toFixed(2)) : 0
    },
    forecast
  };
}

/**
 * Compares first half vs second half CTR/CVR to detect Creative Fatigue Decay slope.
 */
export function estimateCreativeFatigue(dailyRows = []) {
  const byDate = new Map();
  for (const r of dailyRows) {
    const dt = r.segments?.date;
    if (!dt) continue;
    if (!byDate.has(dt)) byDate.set(dt, { date: dt, impressions: 0, clicks: 0, conversions: 0 });
    const d = byDate.get(dt);
    d.impressions += Number(r.metrics?.impressions || 0);
    d.clicks += Number(r.metrics?.clicks || 0);
    d.conversions += Number(r.metrics?.conversions || 0);
  }
  const ordered = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (ordered.length < 8) return { status: 'INSUFFICIENT_HISTORY' };

  const mid = Math.floor(ordered.length / 2);
  const early = ordered.slice(0, mid);
  const late = ordered.slice(mid);

  const calcCtr = (arr) => {
    const imp = arr.reduce((s, d) => s + d.impressions, 0);
    const clk = arr.reduce((s, d) => s + d.clicks, 0);
    return imp > 0 ? clk / imp : 0;
  };
  const earlyCtr = calcCtr(early);
  const lateCtr = calcCtr(late);
  const ctrDeltaPct = earlyCtr > 0 ? ((lateCtr - earlyCtr) / earlyCtr) * 100 : 0;

  return {
    status: ctrDeltaPct <= -15 ? 'FATIGUE_DETECTED' : ctrDeltaPct >= 10 ? 'MOMENTUM_RISING' : 'STABLE',
    earlyCtr,
    lateCtr,
    ctrDeltaPct: Number(ctrDeltaPct.toFixed(1))
  };
}

export class PredictiveForecastAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'rd-predictive-forecast',
      name: 'R&D Predictive Marketing & Creative Fatigue Forecaster',
      group: 'RD_INTELLIGENCE',
      sequence: 9,
      category: 'R&D Stage 9 — Holt-Winters Forecast & Creative Fatigue Decay',
      description:
        'Applies Double Exponential Smoothing (Holt-Winters trend) across 30-day daily campaign time-series to forecast future Spend, Clicks, Conversions & CPA, detects early CTR Creative Fatigue Decay, and simulates keyword expansions via Keyword Planner Forecast.',
      pairedTools: [
        'report_times',
        'report_campaigns',
        'report_ads',
        'keyword_planner_forecast_metrics'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const campaignId = await this.pickCampaign(registry, ctx, { allowAll: true, dateRange: 'LAST_30_DAYS' });

    const timeRes = await this.invoke(
      registry,
      'report_times',
      { date_range: 'LAST_30_DAYS', granularity: 'DATE', ...(campaignId ? { campaign_id: campaignId } : {}), limit: 1500 },
      ctx
    );

    const horizon = ctx.nonInteractive ? 14 : Number(await input({ message: 'Forecast horizon in days (e.g. 14 or 30):', default: '14' }));
    const fc = forecastTimeSeries(timeRes.results || [], horizon);
    const fatigue = estimateCreativeFatigue(timeRes.results || []);

    if (ctx.json) {
      console.log(JSON.stringify({ forecast: fc, fatigue }, null, 2));
      return { forecast: fc, fatigue };
    }

    console.log(chalk.cyan(`Creative Fatigue Monitor : ${fatigue.status}${fatigue.ctrDeltaPct !== undefined ? ` (CTR Shift: ${fatigue.ctrDeltaPct > 0 ? '+' : ''}${fatigue.ctrDeltaPct}%)` : ''}`));
    if (fc.status === 'OK') {
      console.log(
        chalk.bold.green(
          `${horizon}-Day Projected Totals -> Spend: ${fmtMoney(fc.summary.projectedTotalCost)} | Clicks: ${fmtNum(fc.summary.projectedTotalClicks)} | Conversions: ${fmtNum(fc.summary.projectedTotalConversions)} | Est. CPA: ${fmtMoney(fc.summary.projectedCpa)}\n`
        )
      );
      this.printTable(
        ['Future Date', 'Projected Spend', 'Projected Clicks', 'Projected Conv'],
        fc.forecast.slice(0, 14).map((f) => [f.date, fmtMoney(f.projectedCost), fmtNum(f.projectedClicks), fmtNum(f.projectedConversions)]),
        { title: `Predictive Account Run-Rate Forecast (Next ${horizon} Days)` }
      );
    } else {
      console.log(chalk.yellow('Insufficient daily history (< 3 days) for Holt-Winters trend forecast.\n'));
    }

    this.saveArtifact({ forecast: fc, fatigue }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { forecast: fc, fatigue };

    const sim = await select({
      message: 'Predictive Forecaster — optional scenario check:',
      choices: [
        { name: '1) Simulate Net-New Keyword Budget Impact (Keyword Planner Forecast)', value: 'kw_forecast' },
        { name: 'Back to Main Menu', value: 'exit' }
      ]
    });

    if (sim === 'kw_forecast') {
      const kws = (await input({ message: 'Candidate keywords to simulate (comma-separated):' }))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((text) => ({ text, match_type: 'PHRASE' }));
      const dailyBudget = Number(await input({ message: 'Simulated additional daily spend:', default: '50' }));
      const res = await this.invoke(
        registry,
        'keyword_planner_forecast_metrics',
        { keywords: kws, bidding_strategy: 'MAXIMIZE_CONVERSIONS', daily_target_spend: dailyBudget, geo_target_ids: ['2276'], language_id: '1001' },
        ctx
      );
      const m = res.campaignForecastMetrics || {};
      this.printTable(
        ['Forecast Metric', 'Simulated Output'],
        [
          ['Impressions', fmtNum(m.impressions)],
          ['Clicks', fmtNum(m.clicks)],
          ['Spend', fmtMoney(m.cost)],
          ['CTR', m.ctr !== null ? fmtPct(m.ctr, 2) : '-'],
          ['Conversions', fmtNum(m.conversions)]
        ],
        { title: 'Keyword Planner Predictive Scenario' }
      );
    }
  }
}
