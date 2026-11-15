import { select, input } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export function rankDaypartWindows(rows = []) {
  const byDay = new Map();
  for (const r of rows) {
    const key = r.segments?.dayOfWeek || `H${r.segments?.hour ?? '?'}`;
    if (!byDay.has(key)) {
      byDay.set(key, { window: key, impressions: 0, clicks: 0, cost: 0, conversions: 0 });
    }
    const agg = byDay.get(key);
    agg.impressions += Number(r.metrics?.impressions || 0);
    agg.clicks += Number(r.metrics?.clicks || 0);
    agg.cost += fromMicros(r.metrics?.costMicros);
    agg.conversions += Number(r.metrics?.conversions || 0);
  }
  return Array.from(byDay.values())
    .map((w) => ({
      ...w,
      cpa: w.conversions > 0 ? w.cost / w.conversions : Infinity,
      cvr: w.clicks > 0 ? w.conversions / w.clicks : 0
    }))
    .sort((a, b) => b.conversions - a.conversions || b.cost - a.cost);
}

export class DaypartingScheduleAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'dayparting-schedule',
      name: 'Times, Devices & Ad Schedule Dayparting Agent',
      group: 'MCP_PAIRED',
      sequence: 13,
      category: 'Dayparting & Devices',
      description:
        'Analyzes performance across days of week, hours of day, and devices (Desktop/Mobile/Tablet), ranks high- vs low-efficiency daypart windows, and configures Campaign Ad Schedules & bid modifiers.',
      pairedTools: [
        'report_times',
        'report_devices',
        'manage_ad_schedule'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');
    const campaignId = await this.pickCampaign(registry, ctx, { allowAll: true, dateRange });

    const gran = ctx.nonInteractive
      ? 'DAY_OF_WEEK'
      : await select({
          message: 'Time granularity:',
          choices: [
            { name: 'DAY_OF_WEEK (Mon - Sun)', value: 'DAY_OF_WEEK' },
            { name: 'HOUR (0 - 23h)', value: 'HOUR' },
            { name: 'DATE (Daily Time Series)', value: 'DATE' }
          ]
        });

    const [timeRes, devRes] = await Promise.all([
      this.invoke(registry, 'report_times', { date_range: dateRange, granularity: gran, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 500 }, ctx),
      this.invoke(registry, 'report_devices', { date_range: dateRange, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 100 }, ctx).catch(() => ({ results: [] }))
    ]);

    const windows = rankDaypartWindows(timeRes.results || []);
    const devMap = new Map();
    for (const r of devRes.results || []) {
      const dev = r.segments?.device || 'UNKNOWN';
      if (!devMap.has(dev)) devMap.set(dev, { device: dev, clicks: 0, cost: 0, conversions: 0 });
      const d = devMap.get(dev);
      d.clicks += Number(r.metrics?.clicks || 0);
      d.cost += fromMicros(r.metrics?.costMicros);
      d.conversions += Number(r.metrics?.conversions || 0);
    }

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, granularity: gran, windows, devices: Array.from(devMap.values()) }, null, 2));
      return { dateRange, windows };
    }

    this.printTable(
      ['Window', 'Impressions', 'Clicks', 'Spend', 'Conv', 'CVR', 'CPA'],
      windows.slice(0, 24).map((w) => [
        w.window,
        fmtNum(w.impressions),
        fmtNum(w.clicks),
        fmtMoney(w.cost),
        fmtNum(w.conversions),
        fmtPct(w.cvr, 2),
        w.cpa === Infinity ? '-' : fmtMoney(w.cpa)
      ]),
      { title: `Time Breakdown (${gran}, ${dateRange})` }
    );

    this.printTable(
      ['Device', 'Clicks', 'Spend', 'Conversions', 'CPA'],
      Array.from(devMap.values()).map((d) => [
        d.device,
        fmtNum(d.clicks),
        fmtMoney(d.cost),
        fmtNum(d.conversions),
        d.conversions > 0 ? fmtMoney(d.cost / d.conversions) : '-'
      ]),
      { title: 'Device Performance Split' }
    );

    this.saveArtifact({ dateRange, granularity: gran, windows: windows.slice(0, 30) }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, windows };

    while (true) {
      const action = await select({
        message: 'Dayparting Agent — choose action:',
        choices: [
          { name: '1) Create Ad Schedule Window & Bid Modifier on Campaign', value: 'create' },
          { name: '2) Remove Ad Schedule Criterion by Resource Name', value: 'remove' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'create') {
        const targetCamp = campaignId || (await this.pickCampaign(registry, ctx, { allowAll: false, dateRange }));
        const day = await select({
          message: 'Day of Week:',
          choices: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((d) => ({ name: d, value: d }))
        });
        const startHour = Number(await input({ message: 'Start Hour (0-23):', default: '8' }));
        const endHour = Number(await input({ message: 'End Hour (1-24):', default: '20' }));
        const modRaw = await input({ message: 'Bid modifier (e.g. 1.2 for +20%, 0.8 for -20%, blank for 1.0):', default: '' });

        await this.mutate(
          registry,
          {
            toolName: 'manage_ad_schedule',
            payload: {
              operation: 'CREATE',
              campaign_id: targetCamp,
              schedules: [
                {
                  day_of_week: day,
                  start_hour: startHour,
                  end_hour: endHour,
                  ...(modRaw.trim() ? { bid_modifier: Number(modRaw) } : {})
                }
              ]
            },
            summaryTitle: `Add Ad Schedule ${day} ${startHour}:00-${endHour}:00`,
            summaryLines: [`Campaign     : ${targetCamp}`, `Window       : ${day} ${startHour}:00-${endHour}:00`, `Bid Modifier : ${modRaw || 'none'}`]
          },
          ctx
        );
      }

      if (action === 'remove') {
        const targetCamp = campaignId || (await this.pickCampaign(registry, ctx, { allowAll: false, dateRange }));
        const rn = await input({ message: 'Criterion resourceName (customers/{cid}/campaignCriteria/{campId}~{critId}):' });
        await this.mutate(
          registry,
          {
            toolName: 'manage_ad_schedule',
            payload: { operation: 'REMOVE', campaign_id: targetCamp, schedules: [{ criterion_resource_name: rn.trim() }] },
            summaryTitle: 'Remove Ad Schedule Criterion',
            summaryLines: [`Resource : ${rn}`]
          },
          ctx
        );
      }
    }
  }
}
