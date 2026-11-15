import chalk from 'chalk';
import { select, input, confirm } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export function diagnoseCampaigns(campaignRows = [], isRows = []) {
  const isMap = new Map();
  for (const r of isRows) {
    if (r.campaign?.id) {
      isMap.set(String(r.campaign.id), r.metrics || {});
    }
  }

  return campaignRows.map((row) => {
    const c = row.campaign || {};
    const m = row.metrics || {};
    const comp = row.computed || {};
    const ism = isMap.get(String(c.id)) || {};

    const cost = comp.cost ?? fromMicros(m.costMicros);
    const conv = Number(m.conversions || 0);
    const roas = comp.roas ?? (cost > 0 ? Number(m.conversionsValue || 0) / cost : 0);
    const searchIs = Number(ism.searchImpressionShare || 0);
    const budgetLostIs = Number(ism.searchBudgetLostImpressionShare || 0);
    const rankLostIs = Number(ism.searchRankLostImpressionShare || 0);

    const flags = [];
    if (budgetLostIs >= 0.2 && conv > 0) flags.push('BUDGET_THROTTLED_WINNER');
    if (rankLostIs >= 0.35) flags.push('HIGH_RANK_LOSS');
    if (cost >= 100 && conv === 0 && c.status === 'ENABLED') flags.push('ZERO_CONV_BLEEDER');
    if (!flags.length && conv > 0) flags.push('HEALTHY');

    return {
      id: String(c.id),
      name: c.name || 'Unnamed',
      channel: c.advertisingChannelType || 'UNKNOWN',
      status: c.status,
      bidding: c.biddingStrategyType,
      budgetDaily: comp.budgetDaily ?? fromMicros(row.campaignBudget?.amountMicros),
      impressions: Number(m.impressions || 0),
      clicks: Number(m.clicks || 0),
      cost,
      conversions: conv,
      cpa: comp.cpa ?? (conv > 0 ? cost / conv : 0),
      roas,
      searchIs,
      budgetLostIs,
      rankLostIs,
      flags
    };
  });
}

export class CampaignAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'campaign',
      name: 'Campaign Report & Creation Agent',
      group: 'MCP_PAIRED',
      sequence: 2,
      category: 'Campaign Architecture',
      description:
        'Audits campaign performance + Search/Content Impression Share loss, creates new campaigns atomically (Search, PMax, Demand Gen, Display, Shopping, Video) in PAUSED stage, and enables/pauses campaigns.',
      pairedTools: [
        'report_campaigns',
        'report_impression_share',
        'create_campaign',
        'update_entity_status'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [campRes, isRes] = await Promise.all([
      this.invoke(registry, 'report_campaigns', { date_range: dateRange, limit: 150 }, ctx),
      this.invoke(registry, 'report_impression_share', { date_range: dateRange, level: 'CAMPAIGN', limit: 150 }, ctx).catch(
        () => ({ results: [] })
      )
    ]);

    const analyzed = diagnoseCampaigns(campRes.results || [], isRes.results || []);
    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, campaigns: analyzed }, null, 2));
      return { dateRange, campaigns: analyzed };
    }

    this.printTable(
      ['ID', 'Campaign', 'Type', 'Status', 'Daily Bgt', 'Spend', 'Conv', 'CPA', 'ROAS', 'Lost(B/R)', 'Diagnosis'],
      analyzed.map((a) => [
        a.id,
        truncStr(a.name, 26),
        truncStr(a.channel, 10),
        a.status,
        fmtMoney(a.budgetDaily),
        fmtMoney(a.cost),
        fmtNum(a.conversions),
        fmtMoney(a.cpa),
        `${a.roas.toFixed(2)}x`,
        `${fmtPct(a.budgetLostIs, 0)}/${fmtPct(a.rankLostIs, 0)}`,
        a.flags.join(',')
      ]),
      { title: `Campaign Performance & Impression Share Audit (${dateRange})` }
    );

    this.saveArtifact({ dateRange, count: analyzed.length, campaigns: analyzed }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, campaigns: analyzed };

    while (true) {
      const action = await select({
        message: 'Campaign Agent — choose next action:',
        choices: [
          { name: '1) Create New Campaign (+ Daily Budget, staged PAUSED)', value: 'create' },
          { name: '2) Pause or Enable Existing Campaign(s)', value: 'status' },
          { name: '3) Run AI Strategic Review on Campaign Mix', value: 'ai' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'create') {
        const name = await input({ message: 'Campaign name:' });
        const channel = await select({
          message: 'Advertising channel type:',
          choices: [
            { name: 'Search', value: 'SEARCH' },
            { name: 'Performance Max', value: 'PERFORMANCE_MAX' },
            { name: 'Demand Gen', value: 'DEMAND_GEN' },
            { name: 'Display', value: 'DISPLAY' },
            { name: 'Shopping', value: 'SHOPPING' },
            { name: 'Video', value: 'VIDEO' }
          ]
        });
        const dailyBudget = Number(await input({ message: 'Daily budget (account currency):', default: '50' }));
        const bidding = await select({
          message: 'Bidding strategy:',
          choices: [
            { name: 'Maximize Conversions (with optional Target CPA)', value: 'MAXIMIZE_CONVERSIONS' },
            { name: 'Maximize Conversion Value (with optional Target ROAS)', value: 'MAXIMIZE_CONVERSION_VALUE' },
            { name: 'Maximize Clicks', value: 'MAXIMIZE_CLICKS' },
            { name: 'Manual CPC', value: 'MANUAL_CPC' }
          ]
        });
        let targetCpa;
        let targetRoas;
        if (bidding === 'MAXIMIZE_CONVERSIONS') {
          const val = await input({ message: 'Optional Target CPA (blank to omit):', default: '' });
          if (val.trim()) targetCpa = Number(val);
        } else if (bidding === 'MAXIMIZE_CONVERSION_VALUE') {
          const val = await input({ message: 'Optional Target ROAS ratio e.g. 4.0 (blank to omit):', default: '' });
          if (val.trim()) targetRoas = Number(val);
        }
        const status = (await confirm({ message: 'Create in PAUSED state (recommended safe staged rollout)?', default: true }))
          ? 'PAUSED'
          : 'ENABLED';

        const payload = {
          name,
          advertising_channel_type: channel,
          daily_budget: dailyBudget,
          bidding_strategy_type: bidding,
          status,
          ...(targetCpa ? { target_cpa: targetCpa } : {}),
          ...(targetRoas ? { target_roas: targetRoas } : {})
        };

        await this.mutate(
          registry,
          {
            toolName: 'create_campaign',
            payload,
            summaryTitle: `Create ${channel} Campaign "${name}"`,
            summaryLines: [
              `Channel : ${channel}`,
              `Budget  : ${fmtMoney(dailyBudget)} / day`,
              `Bidding : ${bidding}${targetCpa ? ` (tCPA ${targetCpa})` : ''}${targetRoas ? ` (tROAS ${targetRoas}x)` : ''}`,
              `Status  : ${status}`
            ]
          },
          ctx
        );
      }

      if (action === 'status') {
        const targetId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange });
        const newStatus = await select({
          message: `Set status for campaign ${targetId}:`,
          choices: [
            { name: 'PAUSED', value: 'PAUSED' },
            { name: 'ENABLED', value: 'ENABLED' }
          ]
        });
        await this.mutate(
          registry,
          {
            toolName: 'update_entity_status',
            payload: {
              entity_type: 'CAMPAIGN',
              status: newStatus,
              resource_names_or_ids: [targetId]
            },
            summaryTitle: `Set Campaign ${targetId} -> ${newStatus}`,
            summaryLines: [`Campaign ID : ${targetId}`, `New Status  : ${newStatus}`]
          },
          ctx
        );
      }

      if (action === 'ai') {
        await this.offerAiAnalysis(
          { dateRange, campaigns: analyzed },
          'Identify budget reallocation opportunities from bleeders to budget-throttled winners.'
        );
      }
    }
  }
}
