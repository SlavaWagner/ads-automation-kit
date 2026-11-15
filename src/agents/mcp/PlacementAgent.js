import chalk from 'chalk';
import { select, input, checkbox } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export function detectPlacementWaste(rows = [], { minSpendWaste = 10 } = {}) {
  const waste = [];
  for (const r of rows) {
    const view = r.detailPlacementView || r.groupPlacementView || {};
    const placement = view.placement || view.targetUrl || '';
    const displayName = view.displayName || placement;
    const type = view.placementType || 'WEBSITE';
    const cost = fromMicros(r.metrics?.costMicros);
    const conv = Number(r.metrics?.conversions || 0);
    const clicks = Number(r.metrics?.clicks || 0);
    const impressions = Number(r.metrics?.impressions || 0);

    const isMobileApp = /mobileapp|adsenseformobileapps/i.test(String(placement)) || type === 'MOBILE_APPLICATION';
    if ((conv === 0 && cost >= minSpendWaste) || (isMobileApp && conv === 0 && clicks > 5)) {
      let exclusionType = 'PLACEMENT_URL';
      let exclusionValue = view.targetUrl || placement;
      if (type === 'YOUTUBE_CHANNEL') exclusionType = 'YOUTUBE_CHANNEL';
      else if (type === 'YOUTUBE_VIDEO') exclusionType = 'YOUTUBE_VIDEO';
      else if (type === 'MOBILE_APPLICATION') exclusionType = 'MOBILE_APPLICATION';

      waste.push({
        campaignId: r.campaign?.id,
        campaignName: r.campaign?.name || '-',
        placement,
        displayName,
        type,
        exclusionType,
        exclusionValue,
        impressions,
        clicks,
        cost,
        conversions: conv,
        reason: isMobileApp ? 'MOBILE_APP_NO_CONV' : 'ZERO_CONV_SPEND'
      });
    }
  }
  return waste.sort((a, b) => b.cost - a.cost);
}

export class PlacementAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'placement',
      name: 'Placement Report & Exclusion Agent',
      group: 'MCP_PAIRED',
      sequence: 10,
      category: 'Placements & Brand Safety',
      description:
        'Audits Display, Video, and Demand Gen placements (websites, mobile apps, YouTube channels/videos), flags zero-conversion mobile app/junk inventory, and excludes them via exclude_placements or Shared Placement Lists.',
      pairedTools: [
        'report_placements',
        'report_shared_sets',
        'exclude_placements',
        'manage_shared_sets'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');
    const campaignId = await this.pickCampaign(registry, ctx, { allowAll: true, dateRange });

    const [plRes, ssRes] = await Promise.all([
      this.invoke(registry, 'report_placements', { date_range: dateRange, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 300 }, ctx),
      this.invoke(registry, 'report_shared_sets', { limit: 100 }, ctx).catch(() => ({ sharedSets: [] }))
    ]);

    const waste = detectPlacementWaste(plRes.results || [], { minSpendWaste: 10 });
    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, totalPlacements: (plRes.results || []).length, waste }, null, 2));
      return { dateRange, waste };
    }

    this.printTable(
      ['Display Name / Placement', 'Type', 'Reason', 'Clicks', 'Wasted Spend', 'Conv'],
      waste.slice(0, 25).map((w) => [
        truncStr(w.displayName || w.placement, 36),
        truncStr(w.type, 16),
        w.reason,
        fmtNum(w.clicks),
        fmtMoney(w.cost),
        fmtNum(w.conversions)
      ]),
      { title: `Placement Waste Audit (${dateRange})` }
    );

    this.saveArtifact({ dateRange, totalPlacements: (plRes.results || []).length, wasteCount: waste.length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, waste };

    while (true) {
      const action = await select({
        message: 'Placement Agent — choose action:',
        choices: [
          { name: '1) Exclude Flagged Zero-Conversion Placements', value: 'exclude_flagged' },
          { name: '2) Exclude Custom Domain / YouTube Channel / App ID', value: 'exclude_custom' },
          { name: '3) Create Shared Negative Placement List', value: 'shared' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'exclude_flagged') {
        if (!waste.length) {
          console.log(chalk.green('✔ No placement waste flagged above threshold.'));
          continue;
        }
        const picked = await checkbox({
          message: 'Select placements to exclude:',
          choices: waste.slice(0, 25).map((w) => ({
            name: `[${w.type}] ${w.displayName} (${w.exclusionValue}) — ${fmtMoney(w.cost)} spent, 0 conv`,
            value: { placement_type: w.exclusionType, value: w.exclusionValue }
          }))
        });
        if (!picked.length) continue;
        const scope = await select({
          message: 'Exclusion scope:',
          choices: [
            { name: 'ACCOUNT (customerNegativeCriteria)', value: 'ACCOUNT' },
            { name: 'CAMPAIGN', value: 'CAMPAIGN' },
            { name: 'SHARED_SET', value: 'SHARED_SET' }
          ]
        });
        let targetId;
        if (scope === 'CAMPAIGN') targetId = campaignId || (await this.pickCampaign(registry, ctx, { allowAll: false, dateRange }));
        else if (scope === 'SHARED_SET') {
          const sets = (ssRes.sharedSets || []).filter((s) => s.sharedSet?.type === 'NEGATIVE_PLACEMENTS');
          targetId = sets.length
            ? await select({ message: 'Select Placement Exclusion List:', choices: sets.map((s) => ({ name: s.sharedSet.name, value: String(s.sharedSet.id) })) })
            : await input({ message: 'Shared Set ID:' });
        }

        await this.mutate(
          registry,
          {
            toolName: 'exclude_placements',
            payload: { scope, ...(targetId ? { target_id: targetId } : {}), placements: picked },
            summaryTitle: `Exclude ${picked.length} Placements (${scope})`,
            summaryLines: picked.map((p) => `${p.placement_type}: ${p.value}`)
          },
          ctx
        );
      }

      if (action === 'exclude_custom') {
        const pType = await select({
          message: 'Placement type:',
          choices: ['PLACEMENT_URL', 'YOUTUBE_CHANNEL', 'YOUTUBE_VIDEO', 'MOBILE_APPLICATION', 'MOBILE_APP_CATEGORY'].map((v) => ({ name: v, value: v }))
        });
        const val = await input({ message: 'Placement value (e.g. adsenseformobileapps.com or channel ID):' });
        const scope = await select({
          message: 'Exclusion scope:',
          choices: ['ACCOUNT', 'CAMPAIGN', 'AD_GROUP'].map((v) => ({ name: v, value: v }))
        });
        let targetId;
        if (scope === 'CAMPAIGN') targetId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange });
        if (scope === 'AD_GROUP') targetId = await this.pickAdGroup(registry, ctx, { campaignId, allowAll: false, dateRange });
        await this.mutate(
          registry,
          {
            toolName: 'exclude_placements',
            payload: { scope, ...(targetId ? { target_id: targetId } : {}), placements: [{ placement_type: pType, value: val.trim() }] },
            summaryTitle: `Exclude ${pType} (${scope})`,
            summaryLines: [`Value : ${val}`, `Scope : ${scope}`]
          },
          ctx
        );
      }

      if (action === 'shared') {
        const name = await input({ message: 'New Negative Placements Shared Set name:' });
        await this.mutate(
          registry,
          {
            toolName: 'manage_shared_sets',
            payload: { action: 'CREATE_SHARED_SET', name, type: 'NEGATIVE_PLACEMENTS' },
            summaryTitle: `Create Negative Placements List "${name}"`,
            summaryLines: [`Name : ${name}`, 'Type : NEGATIVE_PLACEMENTS']
          },
          ctx
        );
      }
    }
  }
}
