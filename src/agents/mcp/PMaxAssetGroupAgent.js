import { select, input, confirm } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export class PMaxAssetGroupAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'pmax-asset-group',
      name: 'Performance Max Asset Group & Insights Agent',
      group: 'MCP_PAIRED',
      sequence: 7,
      category: 'Performance Max',
      description:
        'Audits PMax Asset Groups (Ad Strength, Search Term Insights, Shopping Product Item performance, linked assets), creates new Asset Groups (PAUSED), attaches Search Themes / Audience signals, and links assets.',
      pairedTools: [
        'report_asset_groups',
        'report_shopping_and_pmax_insights',
        'report_assets',
        'create_asset_group',
        'attach_audience_targeting',
        'link_assets',
        'update_entity_status'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');
    const campaignId = await this.pickCampaign(registry, ctx, { allowAll: true, dateRange, channelType: 'PERFORMANCE_MAX' });

    const [agRes, searchInsightRes] = await Promise.all([
      this.invoke(registry, 'report_asset_groups', { date_range: dateRange, ...(campaignId ? { campaign_id: campaignId } : {}), include_assets: true, include_signals: true }, ctx),
      this.invoke(registry, 'report_shopping_and_pmax_insights', { date_range: dateRange, mode: 'PMAX_SEARCH_INSIGHTS', ...(campaignId ? { campaign_id: campaignId } : {}), limit: 50 }, ctx).catch(() => ({ results: [] }))
    ]);

    const groups = (agRes.results || []).map((r) => {
      const ag = r.assetGroup || {};
      const m = r.metrics || {};
      return {
        id: String(ag.id),
        name: ag.name || '-',
        campaignName: r.campaign?.name || '-',
        status: ag.status,
        adStrength: ag.adStrength || '-',
        finalUrl: ag.finalUrls?.[0] || '-',
        clicks: Number(m.clicks || 0),
        ctr: Number(m.ctr || 0),
        cost: fromMicros(m.costMicros),
        conversions: Number(m.conversions || 0)
      };
    });

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, assetGroups: groups, searchInsights: searchInsightRes.results || [] }, null, 2));
      return { dateRange, assetGroups: groups };
    }

    this.printTable(
      ['AG ID', 'Asset Group', 'Campaign', 'Status', 'Strength', 'Clicks', 'CTR', 'Spend', 'Conv'],
      groups.map((g) => [
        g.id,
        truncStr(g.name, 26),
        truncStr(g.campaignName, 20),
        g.status,
        g.adStrength,
        fmtNum(g.clicks),
        fmtPct(g.ctr, 2),
        fmtMoney(g.cost),
        fmtNum(g.conversions)
      ]),
      { title: `Performance Max Asset Groups (${dateRange})` }
    );

    if ((searchInsightRes.results || []).length) {
      this.printTable(
        ['Search Category Label', 'Clicks', 'Conversions', 'Conv Value'],
        (searchInsightRes.results || []).slice(0, 15).map((r) => [
          truncStr(r.campaignSearchTermInsight?.categoryLabel || '-', 40),
          fmtNum(r.metrics?.clicks),
          fmtNum(r.metrics?.conversions),
          fmtMoney(r.metrics?.conversionsValue)
        ]),
        { title: 'Top PMax Search Term Categories' }
      );
    }

    this.saveArtifact({ dateRange, assetGroups: groups, signalsCount: (agRes.signals || []).length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, assetGroups: groups };

    while (true) {
      const action = await select({
        message: 'PMax Asset Group Agent — choose action:',
        choices: [
          { name: '1) Add PMax Search Themes to an Asset Group', value: 'themes' },
          { name: '2) View Shopping Product Performance (SHOPPING_PRODUCTS)', value: 'products' },
          { name: '3) Create New Performance Max Asset Group (staged PAUSED)', value: 'create' },
          { name: '4) Link Existing Asset to an Asset Group (link_assets)', value: 'link' },
          { name: '5) Pause / Enable Asset Group', value: 'status' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'products') {
        const prodRes = await this.invoke(
          registry,
          'report_shopping_and_pmax_insights',
          { date_range: dateRange, mode: 'SHOPPING_PRODUCTS', ...(campaignId ? { campaign_id: campaignId } : {}), limit: 30 },
          ctx
        );
        this.printTable(
          ['Item ID', 'Product Title', 'Brand', 'Clicks', 'Spend', 'Conv', 'Value'],
          (prodRes.results || []).map((r) => [
            truncStr(r.segments?.productItemId || '-', 16),
            truncStr(r.segments?.productTitle || '-', 32),
            truncStr(r.segments?.productBrand || '-', 14),
            fmtNum(r.metrics?.clicks),
            fmtMoney(fromMicros(r.metrics?.costMicros)),
            fmtNum(r.metrics?.conversions),
            fmtMoney(r.metrics?.conversionsValue)
          ]),
          { title: 'Shopping & PMax Retail Product Item Report' }
        );
      }

      if (action === 'themes') {
        const agId = await input({ message: 'Target Asset Group ID:' });
        const raw = await input({ message: 'Enter Search Themes comma-separated (up to 25):' });
        const themes = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25);
        await this.mutate(
          registry,
          {
            toolName: 'attach_audience_targeting',
            payload: {
              target_level: 'ASSET_GROUP_SEARCH_THEME',
              parent_id: agId,
              search_themes: themes
            },
            summaryTitle: `Attach ${themes.length} Search Themes -> Asset Group ${agId}`,
            summaryLines: [`Asset Group : ${agId}`, `Themes      : ${themes.join(', ')}`]
          },
          ctx
        );
      }

      if (action === 'create') {
        const campId = campaignId || (await this.pickCampaign(registry, ctx, { allowAll: false, dateRange, channelType: 'PERFORMANCE_MAX' }));
        const name = await input({ message: 'Asset Group name:' });
        const url = await input({ message: 'Final URL (https://...):' });
        const themesRaw = await input({ message: 'Optional Search Themes (comma-separated, blank to omit):', default: '' });
        const themes = themesRaw ? themesRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25) : undefined;
        await this.mutate(
          registry,
          {
            toolName: 'create_asset_group',
            payload: {
              campaign_id: campId,
              name,
              final_urls: [url],
              status: 'PAUSED',
              ...(themes?.length ? { search_themes: themes } : {})
            },
            summaryTitle: `Create PAUSED PMax Asset Group "${name}"`,
            summaryLines: [`Campaign : ${campId}`, `Final URL: ${url}`, `Themes   : ${themes ? themes.join(', ') : '(none)'}`]
          },
          ctx
        );
      }

      if (action === 'link') {
        const agId = await input({ message: 'Asset Group ID:' });
        const assetRn = await input({ message: 'Asset ID or Resource Name:' });
        const fieldType = await select({
          message: 'Field Type:',
          choices: ['HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'LOGO', 'YOUTUBE_VIDEO'].map((v) => ({ name: v, value: v }))
        });
        await this.mutate(
          registry,
          {
            toolName: 'link_assets',
            payload: {
              operation: 'CREATE_LINK',
              scope: 'ASSET_GROUP',
              parent_id: agId,
              links: [{ asset_resource_name: assetRn, field_type: fieldType }]
            },
            summaryTitle: `Link ${fieldType} Asset -> Asset Group ${agId}`,
            summaryLines: [`Asset Group : ${agId}`, `Asset       : ${assetRn}`, `Field Type  : ${fieldType}`]
          },
          ctx
        );
      }

      if (action === 'status') {
        const agId = await input({ message: 'Asset Group ID:' });
        const status = await select({
          message: 'Target status:',
          choices: [
            { name: 'PAUSED', value: 'PAUSED' },
            { name: 'ENABLED', value: 'ENABLED' }
          ]
        });
        await this.mutate(
          registry,
          {
            toolName: 'update_entity_status',
            payload: { entity_type: 'ASSET_GROUP', status, resource_names_or_ids: [agId] },
            summaryTitle: `Set Asset Group ${agId} -> ${status}`,
            summaryLines: [`Asset Group ID : ${agId}`, `Status         : ${status}`]
          },
          ctx
        );
      }
    }
  }
}
