import chalk from 'chalk';
import { select, checkbox } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export function jaccardSimilarity(textA, textB) {
  const tok = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2)
    );
  const a = tok(textA);
  const b = tok(textB);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Computes Clickbait vs Hidden Gems quadrant, Redundant Headline Similarity, and 0-100 Creative Health Score.
 */
export function analyzeCreativePortfolioHealth(adRows = [], assetRows = []) {
  const ctrs = adRows.map((r) => Number(r.metrics?.ctr || 0)).filter((v) => v > 0);
  const avgCtr = ctrs.length ? ctrs.reduce((s, v) => s + v, 0) / ctrs.length : 0.03;

  const classifiedAds = adRows.map((r) => {
    const m = r.metrics || {};
    const ctr = Number(m.ctr || 0);
    const conv = Number(m.conversions || 0);
    const impr = Number(m.impressions || 0);
    const clicks = Number(m.clicks || 0);
    const cost = fromMicros(m.costMicros);
    const cvr = clicks > 0 ? conv / clicks : 0;

    let quadrant = 'STANDARD';
    if (ctr >= avgCtr * 1.15 && conv === 0 && clicks >= 25) quadrant = 'CLICKBAIT_TRAP';
    else if (impr < 1000 && conv >= 2 && cvr >= 0.05) quadrant = 'HIDDEN_GEM';
    else if (conv >= 3 && ctr >= avgCtr * 0.9) quadrant = 'SCALABLE_WINNER';
    else if (cost >= 40 && conv === 0 && ctr < avgCtr * 0.7) quadrant = 'DEAD_WEIGHT';

    return {
      adId: String(r.adGroupAd?.ad?.id || ''),
      adGroupId: String(r.adGroup?.id || ''),
      adGroupName: r.adGroup?.name || '-',
      adStrength: r.adGroupAd?.adStrength || 'UNSPECIFIED',
      approval: r.adGroupAd?.policySummary?.approvalStatus || 'APPROVED',
      impressions: impr,
      clicks,
      ctr,
      cvr,
      cost,
      conversions: conv,
      quadrant
    };
  });

  // Check pairwise headline overlap inside each RSA
  const redundancies = [];
  for (const r of adRows) {
    const headlines = (r.adGroupAd?.ad?.responsiveSearchAd?.headlines || []).map((h) => h.text).filter(Boolean);
    for (let i = 0; i < headlines.length; i++) {
      for (let j = i + 1; j < headlines.length; j++) {
        const sim = jaccardSimilarity(headlines[i], headlines[j]);
        if (sim >= 0.7) {
          redundancies.push({
            adId: String(r.adGroupAd?.ad?.id || ''),
            headlineA: headlines[i],
            headlineB: headlines[j],
            similarity: Number(sim.toFixed(2))
          });
        }
      }
    }
  }

  const strengthScoreMap = { EXCELLENT: 100, GOOD: 82, AVERAGE: 58, POOR: 32, UNSPECIFIED: 60 };
  const avgStrengthScore = classifiedAds.length
    ? classifiedAds.reduce((s, a) => s + (strengthScoreMap[a.adStrength] || 60), 0) / classifiedAds.length
    : 50;

  const totalLabels = assetRows.length || 1;
  const bestGoodCount = assetRows.filter((r) => ['BEST', 'GOOD'].includes(r.adGroupAdAssetView?.performanceLabel)).length;
  const approvedRatio = classifiedAds.length
    ? classifiedAds.filter((a) => a.approval === 'APPROVED').length / classifiedAds.length
    : 1;
  const redundancyPenalty = Math.min(20, redundancies.length * 4);

  const compositeHealthScore = Math.max(
    0,
    Math.min(100, Math.round(avgStrengthScore * 0.45 + (bestGoodCount / totalLabels) * 30 + approvedRatio * 25 - redundancyPenalty))
  );

  return {
    avgCtr,
    compositeHealthScore,
    classifiedAds,
    redundancies
  };
}

export class AssetIntelligenceAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'rd-asset-intelligence',
      name: 'R&D Asset Performance Intelligence & Creative Audit Agent',
      group: 'RD_INTELLIGENCE',
      sequence: 4,
      category: 'R&D Stage 4 — Creative Portfolio Health & Redundancy',
      description:
        'Scores portfolio Creative Health (0-100), classifies Ads into Clickbait Traps vs Hidden Gems vs Scalable Winners, detects duplicate/redundant RSA headlines via Jaccard Similarity, and pauses toxic creatives.',
      pairedTools: [
        'report_ads',
        'report_assets',
        'update_entity_status',
        'update_ad'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [adsRes, assetRes] = await Promise.all([
      this.invoke(registry, 'report_ads', { date_range: dateRange, limit: 200 }, ctx),
      this.invoke(registry, 'report_assets', { date_range: dateRange, view: 'AD_ASSET_PERFORMANCE', limit: 300 }, ctx).catch(() => ({ results: [] }))
    ]);

    const intel = analyzeCreativePortfolioHealth(adsRes.results || [], assetRes.results || []);
    const cid = adsRes.customerId || ctx.customerId || '0';

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, ...intel }, null, 2));
      return { dateRange, ...intel };
    }

    console.log(chalk.bold.cyan(`Composite Creative Portfolio Health Score: ${intel.compositeHealthScore} / 100 (Benchmark Avg CTR: ${fmtPct(intel.avgCtr, 2)})\n`));

    this.printTable(
      ['Ad ID', 'Ad Group', 'Strength', 'CTR', 'CVR', 'Conv', 'Spend', 'Quadrant'],
      intel.classifiedAds.slice(0, 25).map((a) => [
        a.adId,
        truncStr(a.adGroupName, 22),
        a.adStrength,
        fmtPct(a.ctr, 2),
        fmtPct(a.cvr, 2),
        fmtNum(a.conversions),
        fmtMoney(a.cost),
        a.quadrant
      ]),
      { title: 'Clickbait vs Hidden Gems Creative Quadrant Matrix' }
    );

    if (intel.redundancies.length) {
      this.printTable(
        ['Ad ID', 'Similarity', 'Headline A', 'Headline B'],
        intel.redundancies.slice(0, 12).map((r) => [r.adId, r.similarity, truncStr(r.headlineA, 28), truncStr(r.headlineB, 28)]),
        { title: 'Redundant / Near-Duplicate RSA Headlines (>= 0.70 Jaccard)' }
      );
    }

    this.saveArtifact({ dateRange, healthScore: intel.compositeHealthScore, redundancies: intel.redundancies.length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, ...intel };

    const traps = intel.classifiedAds.filter((a) => a.quadrant === 'CLICKBAIT_TRAP' || a.quadrant === 'DEAD_WEIGHT');
    if (traps.length) {
      const action = await select({
        message: 'Remediation options:',
        choices: [
          { name: `Pause Clickbait Trap / Dead Weight Ads (${traps.length} found)`, value: 'pause' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });
      if (action === 'pause') {
        const picked = await checkbox({
          message: 'Select Ads to PAUSE:',
          choices: traps.map((t) => ({
            name: `[${t.quadrant}] Ad ${t.adId} (${t.adGroupName}) — CTR ${fmtPct(t.ctr)}, Spend ${fmtMoney(t.cost)}, ${t.conversions} conv`,
            value: `customers/${cid}/adGroupAds/${t.adGroupId}~${t.adId}`
          }))
        });
        if (picked.length) {
          await this.mutate(
            registry,
            {
              toolName: 'update_entity_status',
              payload: { entity_type: 'AD_GROUP_AD', status: 'PAUSED', resource_names_or_ids: picked },
              summaryTitle: `Pause ${picked.length} Clickbait/Dead Weight Ads`,
              summaryLines: picked
            },
            ctx
          );
        }
      }
    }
  }
}
