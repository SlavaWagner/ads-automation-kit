import { select, input, confirm } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, fmtPct, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export class AdGroupAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'ad-group',
      name: 'Ad Group Report & Management Agent',
      group: 'MCP_PAIRED',
      sequence: 3,
      category: 'Campaign Architecture',
      description:
        'Analyzes Ad Group performance, CPC/Target CPA/ROAS overrides, and Impression Share; creates new Ad Groups (staged PAUSED), toggles status, or updates Ad Group-level Target CPA/ROAS.',
      pairedTools: [
        'report_ad_groups',
        'report_impression_share',
        'create_ad_group',
        'update_entity_status',
        'adjust_target_cpa',
        'adjust_target_roas'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');
    const campaignId = await this.pickCampaign(registry, ctx, { allowAll: true, dateRange });

    const [agRes, isRes] = await Promise.all([
      this.invoke(registry, 'report_ad_groups', { date_range: dateRange, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 150 }, ctx),
      this.invoke(registry, 'report_impression_share', { date_range: dateRange, level: 'AD_GROUP', ...(campaignId ? { campaign_id: campaignId } : {}), limit: 150 }, ctx).catch(() => ({ results: [] }))
    ]);

    const isMap = new Map((isRes.results || []).map((r) => [String(r.adGroup?.id), r.metrics || {}]));
    const rows = (agRes.results || []).map((r) => {
      const ag = r.adGroup || {};
      const m = r.metrics || {};
      const ism = isMap.get(String(ag.id)) || {};
      const cost = fromMicros(m.costMicros);
      const conv = Number(m.conversions || 0);
      return {
        id: String(ag.id),
        campaignName: r.campaign?.name || '-',
        name: ag.name || '-',
        status: ag.status,
        cpcBid: fromMicros(ag.cpcBidMicros),
        effTargetCpa: fromMicros(ag.effectiveTargetCpaMicros),
        effTargetRoas: ag.effectiveTargetRoas || 0,
        clicks: Number(m.clicks || 0),
        cost,
        conversions: conv,
        cpa: conv > 0 ? cost / conv : 0,
        searchIs: Number(ism.searchImpressionShare || 0)
      };
    });

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, adGroups: rows }, null, 2));
      return { dateRange, adGroups: rows };
    }

    this.printTable(
      ['ID', 'Ad Group', 'Campaign', 'Status', 'Max CPC', 'Eff tCPA', 'Spend', 'Conv', 'CPA', 'Search IS'],
      rows.map((r) => [
        r.id,
        truncStr(r.name, 26),
        truncStr(r.campaignName, 20),
        r.status,
        fmtMoney(r.cpcBid),
        fmtMoney(r.effTargetCpa),
        fmtMoney(r.cost),
        fmtNum(r.conversions),
        fmtMoney(r.cpa),
        fmtPct(r.searchIs, 1)
      ]),
      { title: `Ad Group Performance & Bid Override Report (${dateRange})` }
    );

    this.saveArtifact({ dateRange, adGroups: rows }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, adGroups: rows };

    while (true) {
      const action = await select({
        message: 'Ad Group Agent — choose next action:',
        choices: [
          { name: '1) Create New Ad Group inside a Campaign (staged PAUSED)', value: 'create' },
          { name: '2) Pause / Enable Ad Group', value: 'status' },
          { name: '3) Adjust Ad Group Target CPA Override', value: 'tcpa' },
          { name: '4) Adjust Ad Group Target ROAS Override', value: 'troas' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'create') {
        const targetCampId = campaignId || (await this.pickCampaign(registry, ctx, { allowAll: false, dateRange }));
        const name = await input({ message: 'Ad Group name:' });
        const type = await select({
          message: 'Ad Group type:',
          choices: [
            { name: 'SEARCH_STANDARD', value: 'SEARCH_STANDARD' },
            { name: 'SEARCH_DYNAMIC_ADS', value: 'SEARCH_DYNAMIC_ADS' },
            { name: 'DISPLAY_STANDARD', value: 'DISPLAY_STANDARD' },
            { name: 'SHOPPING_PRODUCT_ADS', value: 'SHOPPING_PRODUCT_ADS' }
          ]
        });
        const cpcRaw = await input({ message: 'Optional default Max CPC bid (blank to skip):', default: '' });
        const status = (await confirm({ message: 'Create in PAUSED state?', default: true })) ? 'PAUSED' : 'ENABLED';

        await this.mutate(
          registry,
          {
            toolName: 'create_ad_group',
            payload: {
              campaign_id: targetCampId,
              name,
              type,
              status,
              ...(cpcRaw.trim() ? { cpc_bid: Number(cpcRaw) } : {})
            },
            summaryTitle: `Create Ad Group "${name}"`,
            summaryLines: [`Campaign ID : ${targetCampId}`, `Type        : ${type}`, `Status      : ${status}`]
          },
          ctx
        );
      }

      if (action === 'status') {
        const agId = await this.pickAdGroup(registry, ctx, { campaignId, allowAll: false, dateRange });
        const status = await select({
          message: `New status for Ad Group ${agId}:`,
          choices: [
            { name: 'PAUSED', value: 'PAUSED' },
            { name: 'ENABLED', value: 'ENABLED' }
          ]
        });
        await this.mutate(
          registry,
          {
            toolName: 'update_entity_status',
            payload: { entity_type: 'AD_GROUP', status, resource_names_or_ids: [agId] },
            summaryTitle: `Set Ad Group ${agId} -> ${status}`,
            summaryLines: [`Ad Group ID : ${agId}`, `New Status  : ${status}`]
          },
          ctx
        );
      }

      if (action === 'tcpa') {
        const agId = await this.pickAdGroup(registry, ctx, { campaignId, allowAll: false, dateRange });
        const targetCpa = Number(await input({ message: 'New Ad Group Target CPA (account currency):' }));
        await this.mutate(
          registry,
          {
            toolName: 'adjust_target_cpa',
            payload: { level: 'AD_GROUP', entity_id: agId, target_cpa: targetCpa },
            summaryTitle: `Update Ad Group ${agId} Target CPA -> ${fmtMoney(targetCpa)}`,
            summaryLines: [`Ad Group ID : ${agId}`, `Target CPA  : ${fmtMoney(targetCpa)}`]
          },
          ctx
        );
      }

      if (action === 'troas') {
        const agId = await this.pickAdGroup(registry, ctx, { campaignId, allowAll: false, dateRange });
        const targetRoas = Number(await input({ message: 'New Ad Group Target ROAS ratio (e.g. 4.0 = 400%):' }));
        await this.mutate(
          registry,
          {
            toolName: 'adjust_target_roas',
            payload: { level: 'AD_GROUP', entity_id: agId, target_roas: targetRoas },
            summaryTitle: `Update Ad Group ${agId} Target ROAS -> ${targetRoas}x`,
            summaryLines: [`Ad Group ID  : ${agId}`, `Target ROAS  : ${targetRoas}x`]
          },
          ctx
        );
      }
    }
  }
}
