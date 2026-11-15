import chalk from 'chalk';
import { select, checkbox } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

/**
 * Evaluates creative test significance, Kill-Rule violations, and Ad Group Testing Saturation.
 */
export function evaluateAssetTests(adRows = [], adAssetRows = [], { minImpressions = 1000, minClicks = 30 } = {}) {
  const byAdGroup = new Map();
  const adKillCandidates = [];

  for (const r of adRows) {
    const agId = String(r.adGroup?.id || '');
    const adId = String(r.adGroupAd?.ad?.id || '');
    const status = r.adGroupAd?.status;
    const impr = Number(r.metrics?.impressions || 0);
    const clicks = Number(r.metrics?.clicks || 0);
    const cost = fromMicros(r.metrics?.costMicros);
    const conv = Number(r.metrics?.conversions || 0);
    const ctr = Number(r.metrics?.ctr || 0);

    if (!byAdGroup.has(agId)) {
      byAdGroup.set(agId, { adGroupId: agId, adGroupName: r.adGroup?.name || '-', campaignName: r.campaign?.name || '-', activeAds: 0, poorAds: 0, totalClicks: 0 });
    }
    const ag = byAdGroup.get(agId);
    if (status === 'ENABLED') {
      ag.activeAds += 1;
      if (['POOR', 'AVERAGE'].includes(r.adGroupAd?.adStrength)) ag.poorAds += 1;
    }
    ag.totalClicks += clicks;

    const statisticalReady = impr >= minImpressions || clicks >= minClicks;
    if (status === 'ENABLED' && statisticalReady && conv === 0 && cost >= 40 && ag.activeAds >= 1) {
      adKillCandidates.push({
        adId,
        adGroupId: agId,
        adGroupName: r.adGroup?.name || '-',
        resourceName: `customers/${r._customerId || '0'}/adGroupAds/${agId}~${adId}`,
        adStrength: r.adGroupAd?.adStrength || '-',
        impressions: impr,
        clicks,
        ctr,
        cost,
        verdict: 'KILL_NO_CONV_AFTER_THRESHOLD'
      });
    }
  }

  const assetKillCandidates = [];
  for (const r of adAssetRows) {
    const label = r.adGroupAdAssetView?.performanceLabel;
    const impr = Number(r.metrics?.impressions || 0);
    if (label === 'LOW' && impr >= minImpressions) {
      assetKillCandidates.push({
        fieldType: r.adGroupAdAssetView?.fieldType,
        text: r.asset?.textAsset?.text || '-',
        impressions: impr,
        clicks: Number(r.metrics?.clicks || 0),
        conversions: Number(r.metrics?.conversions || 0),
        label
      });
    }
  }

  const stagnantAdGroups = Array.from(byAdGroup.values())
    .filter((ag) => ag.activeAds === 1 || ag.poorAds > 0)
    .sort((a, b) => b.totalClicks - a.totalClicks);

  return {
    adKillCandidates: adKillCandidates.sort((a, b) => b.cost - a.cost),
    assetKillCandidates: assetKillCandidates.sort((a, b) => b.impressions - a.impressions),
    stagnantAdGroups
  };
}

export class AssetTestingAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'rd-asset-testing',
      name: 'R&D Asset Testing Architecture & Kill-Rule Agent',
      group: 'RD_INTELLIGENCE',
      sequence: 3,
      category: 'R&D Stage 3 — Asset Testing Architecture & Kill-Rules',
      description:
        'Enforces statistical significance gates (min 1,000 impr / 30 clicks), flags LOW-labeled asset & zero-conversion ad Kill Candidates, spots Ad Groups without challenger B-variants, and stages challenger RSAs or pauses losers.',
      pairedTools: [
        'report_ads',
        'report_assets',
        'report_ad_groups',
        'create_ad',
        'update_entity_status'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [adsRes, assetPerfRes] = await Promise.all([
      this.invoke(registry, 'report_ads', { date_range: dateRange, limit: 200 }, ctx),
      this.invoke(registry, 'report_assets', { date_range: dateRange, view: 'AD_ASSET_PERFORMANCE', limit: 300 }, ctx).catch(() => ({ results: [] }))
    ]);

    const cid = adsRes.customerId || ctx.customerId || '0';
    const enrichedAds = (adsRes.results || []).map((r) => ({ ...r, _customerId: cid }));
    const evalRes = evaluateAssetTests(enrichedAds, assetPerfRes.results || []);

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, ...evalRes }, null, 2));
      return { dateRange, ...evalRes };
    }

    this.printTable(
      ['Ad Group', 'Campaign', 'Active Ads', 'Weak/Avg Strength', 'Total Clicks', 'Recommendation'],
      evalRes.stagnantAdGroups.slice(0, 15).map((ag) => [
        truncStr(ag.adGroupName, 24),
        truncStr(ag.campaignName, 20),
        ag.activeAds,
        ag.poorAds,
        fmtNum(ag.totalClicks),
        ag.activeAds === 1 ? 'ADD_CHALLENGER_RSA' : 'UPGRADE_STRENGTH'
      ]),
      { title: `Ad Groups Needing Creative Testing Challengers (${dateRange})` }
    );

    this.printTable(
      ['Field Type', 'Google Label', 'Low-Performing Asset Text', 'Impr', 'Clicks', 'Conv'],
      evalRes.assetKillCandidates.slice(0, 15).map((a) => [
        a.fieldType,
        a.label,
        truncStr(a.text, 36),
        fmtNum(a.impressions),
        fmtNum(a.clicks),
        fmtNum(a.conversions)
      ]),
      { title: 'Statistically Significant LOW Assets (Replace in Next Iteration)' }
    );

    this.saveArtifact({ dateRange, stagnantCount: evalRes.stagnantAdGroups.length, adKills: evalRes.adKillCandidates.length, assetKills: evalRes.assetKillCandidates.length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, ...evalRes };

    while (true) {
      const action = await select({
        message: 'Asset Testing Agent — choose action:',
        choices: [
          { name: '1) Pause Underperforming / Zero-Conversion Ads (with safeguard)', value: 'pause' },
          { name: '2) Launch "rd-asset-generator" guidance or view Stagnant Ad Groups', value: 'info' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'pause') {
        if (!evalRes.adKillCandidates.length) {
          console.log(chalk.green('✔ No enabled ads crossed statistical zero-conversion kill thresholds.'));
          continue;
        }
        const picked = await checkbox({
          message: 'Select statistically losing Ads to PAUSE:',
          choices: evalRes.adKillCandidates.map((k) => ({
            name: `[Ad ${k.adId}] ${k.adGroupName} — ${k.clicks} clicks, ${fmtMoney(k.cost)} spent, 0 conv`,
            value: k.resourceName
          }))
        });
        if (!picked.length) continue;
        await this.mutate(
          registry,
          {
            toolName: 'update_entity_status',
            payload: { entity_type: 'AD_GROUP_AD', status: 'PAUSED', resource_names_or_ids: picked },
            summaryTitle: `Pause ${picked.length} Losing Test Ad(s)`,
            summaryLines: picked
          },
          ctx
        );
      }

      if (action === 'info') {
        console.log(chalk.cyan('\nTip: Run the `rd-asset-generator` CLI agent next to draft & stage Challenger B-variant RSAs for the stagnant Ad Groups listed above.\n'));
      }
    }
  }
}
