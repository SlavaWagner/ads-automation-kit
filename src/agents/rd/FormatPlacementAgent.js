import chalk from 'chalk';
import { select, checkbox } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

/**
 * Pure Cross-Format Channel & Device & Placement Yield Analyzer.
 */
export function analyzeCrossFormatYield(campaignRows = [], deviceRows = [], placementRows = []) {
  const byChannel = new Map();
  for (const r of campaignRows) {
    const ch = r.campaign?.advertisingChannelType || 'UNKNOWN';
    if (!byChannel.has(ch)) byChannel.set(ch, { channel: ch, campaigns: 0, impressions: 0, clicks: 0, cost: 0, conversions: 0, value: 0 });
    const agg = byChannel.get(ch);
    agg.campaigns += 1;
    agg.impressions += Number(r.metrics?.impressions || 0);
    agg.clicks += Number(r.metrics?.clicks || 0);
    agg.cost += r.computed?.cost ?? fromMicros(r.metrics?.costMicros);
    agg.conversions += Number(r.metrics?.conversions || 0);
    agg.value += Number(r.metrics?.conversionsValue || 0);
  }

  const channels = Array.from(byChannel.values())
    .map((c) => ({
      ...c,
      ctr: c.impressions > 0 ? c.clicks / c.impressions : 0,
      cpa: c.conversions > 0 ? c.cost / c.conversions : 0,
      roas: c.cost > 0 ? Number((c.value / c.cost).toFixed(2)) : 0
    }))
    .sort((a, b) => b.cost - a.cost);

  const byDevice = new Map();
  for (const r of deviceRows) {
    const dev = r.segments?.device || 'UNKNOWN';
    if (!byDevice.has(dev)) byDevice.set(dev, { device: dev, clicks: 0, cost: 0, conversions: 0 });
    const d = byDevice.get(dev);
    d.clicks += Number(r.metrics?.clicks || 0);
    d.cost += fromMicros(r.metrics?.costMicros);
    d.conversions += Number(r.metrics?.conversions || 0);
  }

  const bleederPlacements = (placementRows || [])
    .map((r) => {
      const v = r.detailPlacementView || r.groupPlacementView || {};
      const cost = fromMicros(r.metrics?.costMicros);
      const conv = Number(r.metrics?.conversions || 0);
      return {
        placement: v.placement || v.targetUrl || '-',
        displayName: v.displayName || v.placement || '-',
        type: v.placementType || 'WEBSITE',
        targetUrl: v.targetUrl || v.placement || '',
        cost,
        conversions: conv
      };
    })
    .filter((p) => p.conversions === 0 && p.cost >= 10)
    .sort((a, b) => b.cost - a.cost);

  return {
    channels,
    devices: Array.from(byDevice.values()).map((d) => ({ ...d, cpa: d.conversions > 0 ? d.cost / d.conversions : 0 })),
    bleederPlacements
  };
}

export class FormatPlacementAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'rd-format-placement',
      name: 'R&D Ad Format, Device & Placement Yield Agent',
      group: 'RD_INTELLIGENCE',
      sequence: 7,
      category: 'R&D Stage 7 — Cross-Format, Device & Placement Yield',
      description:
        'Compares ROI across Google Ads formats (Search, PMax, Demand Gen, Display, Shopping) and Devices, isolates zero-conversion Display/Video/App placement waste, and executes batch Placement Exclusions.',
      pairedTools: [
        'report_campaigns',
        'report_ads',
        'report_devices',
        'report_placements',
        'exclude_placements'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [campRes, devRes, plRes] = await Promise.all([
      this.invoke(registry, 'report_campaigns', { date_range: dateRange, limit: 150 }, ctx),
      this.invoke(registry, 'report_devices', { date_range: dateRange, limit: 100 }, ctx).catch(() => ({ results: [] })),
      this.invoke(registry, 'report_placements', { date_range: dateRange, limit: 250 }, ctx).catch(() => ({ results: [] }))
    ]);

    const yieldData = analyzeCrossFormatYield(campRes.results || [], devRes.results || [], plRes.results || []);
    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, ...yieldData }, null, 2));
      return { dateRange, ...yieldData };
    }

    this.printTable(
      ['Channel Format', 'Camps', 'CTR', 'Spend', 'Conv', 'CPA', 'ROAS'],
      yieldData.channels.map((c) => [
        c.channel,
        c.campaigns,
        fmtPct(c.ctr, 2),
        fmtMoney(c.cost),
        fmtNum(c.conversions),
        fmtMoney(c.cpa),
        `${c.roas}x`
      ]),
      { title: `Cross-Format Channel Yield Matrix (${dateRange})` }
    );

    this.printTable(
      ['Device', 'Clicks', 'Spend', 'Conversions', 'CPA'],
      yieldData.devices.map((d) => [d.device, fmtNum(d.clicks), fmtMoney(d.cost), fmtNum(d.conversions), fmtMoney(d.cpa)]),
      { title: 'Device Format Split' }
    );

    this.saveArtifact({ dateRange, channelsCount: yieldData.channels.length, bleedersCount: yieldData.bleederPlacements.length }, ctx.nonInteractive);
    if (ctx.nonInteractive || !yieldData.bleederPlacements.length) return { dateRange, ...yieldData };

    const action = await select({
      message: `${yieldData.bleederPlacements.length} zero-conversion placements spotted. Exclude top bleeders?`,
      choices: [
        { name: 'Yes — Select Bleeder Placements to Exclude at ACCOUNT Scope', value: 'exclude' },
        { name: 'No — Back to Main Menu', value: 'exit' }
      ]
    });

    if (action === 'exclude') {
      const picked = await checkbox({
        message: 'Select placements to exclude:',
        choices: yieldData.bleederPlacements.slice(0, 20).map((p) => ({
          name: `[${p.type}] ${p.displayName} — ${fmtMoney(p.cost)} spent, 0 conv`,
          value: {
            placement_type: p.type === 'YOUTUBE_CHANNEL' ? 'YOUTUBE_CHANNEL' : p.type === 'MOBILE_APPLICATION' ? 'MOBILE_APPLICATION' : 'PLACEMENT_URL',
            value: p.targetUrl
          }
        }))
      });
      if (picked.length) {
        await this.mutate(
          registry,
          {
            toolName: 'exclude_placements',
            payload: { scope: 'ACCOUNT', placements: picked },
            summaryTitle: `Exclude ${picked.length} Low-Yield Placements (ACCOUNT)`,
            summaryLines: picked.map((p) => `${p.placement_type}: ${p.value}`)
          },
          ctx
        );
      }
    }
  }
}
