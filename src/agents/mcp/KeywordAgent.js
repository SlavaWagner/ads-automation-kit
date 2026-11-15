import chalk from 'chalk';
import { select, input, checkbox, confirm } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

/**
 * Deduplicates Keyword Planner ideas against existing account keywords and computes opportunity score.
 */
export function scoreAndFilterKeywordIdeas(existingKeywords = [], plannerIdeas = [], { minVolume = 50 } = {}) {
  const existingSet = new Set(
    existingKeywords.map((k) =>
      String(k?.adGroupCriterion?.keyword?.text || k?.text || k)
        .toLowerCase()
        .trim()
    )
  );

  const candidates = [];
  for (const idea of plannerIdeas) {
    const text = String(idea?.text || '').trim();
    if (!text) continue;
    const norm = text.toLowerCase();
    if (existingSet.has(norm)) continue;

    const m = idea.metrics || {};
    const vol = Number(m.avgMonthlySearches || 0);
    if (vol < minVolume) continue;

    const compIdx = Number(m.competitionIndex ?? 50);
    const lowBid = Number(m.lowTopOfPageBid || 0);
    const highBid = Number(m.highTopOfPageBid || 0);
    // Opportunity heuristic: higher search volume + moderate/lower competition efficiency
    const opportunityScore = Number(((Math.log10(vol + 10) * 35) * (1 - compIdx / 200)).toFixed(1));

    candidates.push({
      text,
      avgMonthlySearches: vol,
      competition: m.competition || 'UNKNOWN',
      competitionIndex: compIdx,
      lowTopOfPageBid: lowBid,
      highTopOfPageBid: highBid,
      suggestedBid: lowBid > 0 ? Number(((lowBid + (highBid || lowBid)) / 2).toFixed(2)) : undefined,
      opportunityScore
    });
  }

  return candidates.sort((a, b) => b.opportunityScore - a.opportunityScore);
}

export class KeywordAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'keyword',
      name: 'Keyword Report, Keyword Planner Research & Upload Agent',
      group: 'MCP_PAIRED',
      sequence: 4,
      category: 'Keywords & Demand',
      description:
        'Pulls Keyword performance & Quality Scores + Impression Share, runs Google Ads Keyword Planner (ideas, historical volume & traffic forecasts), filters net-new opportunities, and uploads approved keywords into Ad Groups after confirmation.',
      pairedTools: [
        'report_keywords',
        'report_impression_share',
        'report_search_terms',
        'keyword_planner_generate_ideas',
        'keyword_planner_historical_metrics',
        'keyword_planner_forecast_metrics',
        'create_keywords',
        'update_entity_status'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');
    const campaignId = await this.pickCampaign(registry, ctx, { allowAll: true, dateRange, channelType: 'SEARCH' });

    const [kwRes, isRes] = await Promise.all([
      this.invoke(registry, 'report_keywords', { date_range: dateRange, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 200 }, ctx),
      this.invoke(registry, 'report_impression_share', { date_range: dateRange, level: 'KEYWORD', ...(campaignId ? { campaign_id: campaignId } : {}), limit: 200 }, ctx).catch(() => ({ results: [] }))
    ]);

    const kwRows = (kwRes.results || []).map((r) => {
      const crit = r.adGroupCriterion || {};
      const kw = crit.keyword || {};
      const qi = crit.qualityInfo || {};
      const m = r.metrics || {};
      const cost = fromMicros(m.costMicros);
      const conv = Number(m.conversions || 0);
      return {
        criterionResourceName: `customers/${kwRes.customerId}/adGroupCriteria/${r.adGroup?.id}~${crit.criterionId}`,
        adGroupId: r.adGroup?.id,
        adGroupName: r.adGroup?.name || '-',
        text: kw.text || '-',
        matchType: kw.matchType || '-',
        status: crit.status,
        qs: qi.qualityScore ?? '-',
        cost,
        clicks: Number(m.clicks || 0),
        ctr: Number(m.ctr || 0),
        conversions: conv,
        cpa: conv > 0 ? cost / conv : 0
      };
    });

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, keywords: kwRows, impressionShareCount: (isRes.results || []).length }, null, 2));
      return { dateRange, keywords: kwRows };
    }

    this.printTable(
      ['Keyword', 'Match', 'Ad Group', 'Status', 'QS', 'Clicks', 'CTR', 'Spend', 'Conv', 'CPA'],
      kwRows.map((k) => [
        truncStr(k.text, 28),
        k.matchType,
        truncStr(k.adGroupName, 18),
        k.status,
        k.qs,
        fmtNum(k.clicks),
        fmtPct(k.ctr, 2),
        fmtMoney(k.cost),
        fmtNum(k.conversions),
        fmtMoney(k.cpa)
      ]),
      { title: `Active Keyword Performance & Quality Score (${dateRange})` }
    );

    this.saveArtifact({ dateRange, keywordsCount: kwRows.length, sample: kwRows.slice(0, 50) }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, keywords: kwRows };

    while (true) {
      const action = await select({
        message: 'Keyword Agent — choose next workflow:',
        choices: [
          { name: '1) Discover Net-New Keywords in Google Ads Keyword Planner -> Select & Upload', value: 'planner_upload' },
          { name: '2) Check Historical Volume & Bid Estimates for Custom List', value: 'historical' },
          { name: '3) Forecast Clicks/Cost/Conversions for Candidate Keywords', value: 'forecast' },
          { name: '4) Pause Zero-Conversion / Low-QS Bleeder Keywords', value: 'pause_bleeders' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'planner_upload') {
        const seedsRaw = await input({ message: 'Seed keywords (comma-separated, optional if URL provided):', default: '' });
        const url = await input({ message: 'Landing page URL (optional if seeds provided):', default: '' });
        const geoId = await input({ message: 'Geo target ID (e.g. 2276 Germany, 2840 US, 2040 Austria, 2756 Switzerland):', default: '2276' });
        const langId = await input({ message: 'Language ID (1001 German, 1000 English):', default: '1001' });

        const seedKeywords = seedsRaw ? seedsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const plannerRes = await this.invoke(
          registry,
          'keyword_planner_generate_ideas',
          {
            ...(seedKeywords?.length ? { seed_keywords: seedKeywords } : {}),
            ...(url.trim() ? { url: url.trim() } : {}),
            geo_target_ids: [geoId],
            language_id: langId,
            page_size: 100
          },
          ctx
        );

        const netNew = scoreAndFilterKeywordIdeas(kwRes.results || [], plannerRes.ideas || [], { minVolume: 20 });
        this.printTable(
          ['Score', 'Net-New Keyword Idea', 'Monthly Vol', 'Comp', 'Low Bid', 'High Bid'],
          netNew.slice(0, 25).map((c) => [
            c.opportunityScore,
            truncStr(c.text, 34),
            fmtNum(c.avgMonthlySearches),
            `${c.competition} (${c.competitionIndex})`,
            fmtMoney(c.lowTopOfPageBid),
            fmtMoney(c.highTopOfPageBid)
          ]),
          { title: `Keyword Planner Net-New Opportunities (${netNew.length} deduplicated from account)` }
        );

        if (!netNew.length) continue;

        const pickedTexts = await checkbox({
          message: 'Select keywords to stage for campaign test upload (Space to toggle, Enter to confirm):',
          choices: netNew.slice(0, 20).map((c) => ({
            name: `${c.text} (Vol: ${fmtNum(c.avgMonthlySearches)}, Comp: ${c.competition}, Score: ${c.opportunityScore})`,
            value: c.text
          }))
        });

        if (!pickedTexts.length) continue;

        const targetAdGroupId = await this.pickAdGroup(registry, ctx, { campaignId, allowAll: false, dateRange });
        const matchType = await select({
          message: 'Match type for uploaded test keywords:',
          choices: [
            { name: 'EXACT (tightest control)', value: 'EXACT' },
            { name: 'PHRASE (balanced)', value: 'PHRASE' },
            { name: 'BROAD (requires Smart Bidding + negatives)', value: 'BROAD' }
          ],
          default: 'PHRASE'
        });
        const initialStatus = (await confirm({ message: 'Stage uploaded keywords as PAUSED first (recommended)?', default: true }))
          ? 'PAUSED'
          : 'ENABLED';

        const kwObjects = pickedTexts.map((text) => ({ text, match_type: matchType, status: initialStatus }));

        await this.mutate(
          registry,
          {
            toolName: 'create_keywords',
            payload: {
              ad_group_id: targetAdGroupId,
              keywords: kwObjects,
              default_status: initialStatus
            },
            summaryTitle: `Upload ${kwObjects.length} ${matchType} Keywords -> Ad Group ${targetAdGroupId}`,
            summaryLines: [
              `Ad Group : ${targetAdGroupId}`,
              `Match    : ${matchType}`,
              `Status   : ${initialStatus}`,
              `Keywords : ${pickedTexts.join(', ')}`
            ],
            baselineSnapshot: { countBefore: kwRows.length }
          },
          ctx
        );
      }

      if (action === 'historical') {
        const listRaw = await input({ message: 'Comma-separated keywords to check:' });
        const geoId = await input({ message: 'Geo ID:', default: '2276' });
        const langId = await input({ message: 'Language ID:', default: '1001' });
        const res = await this.invoke(
          registry,
          'keyword_planner_historical_metrics',
          { keywords: listRaw.split(',').map((s) => s.trim()).filter(Boolean), geo_target_ids: [geoId], language_id: langId },
          ctx
        );
        this.printTable(
          ['Keyword', 'Avg Monthly Searches', 'Competition', 'Low Top Bid', 'High Top Bid'],
          (res.results || []).map((r) => [
            truncStr(r.text, 34),
            fmtNum(r.metrics?.avgMonthlySearches),
            r.metrics?.competition || '-',
            fmtMoney(r.metrics?.lowTopOfPageBid),
            fmtMoney(r.metrics?.highTopOfPageBid)
          ]),
          { title: 'Keyword Planner Historical Metrics' }
        );
      }

      if (action === 'forecast') {
        const listRaw = await input({ message: 'Comma-separated keywords to forecast:' });
        const dailyBudget = Number(await input({ message: 'Simulated Daily Budget (currency):', default: '50' }));
        const res = await this.invoke(
          registry,
          'keyword_planner_forecast_metrics',
          {
            keywords: listRaw.split(',').map((s) => s.trim()).filter(Boolean).map((text) => ({ text, match_type: 'PHRASE' })),
            bidding_strategy: 'MAXIMIZE_CONVERSIONS',
            daily_target_spend: dailyBudget,
            geo_target_ids: ['2276'],
            language_id: '1001'
          },
          ctx
        );
        const f = res.campaignForecastMetrics || {};
        this.printTable(
          ['Metric', 'Forecast Estimate'],
          [
            ['Impressions', fmtNum(f.impressions)],
            ['Clicks', fmtNum(f.clicks)],
            ['Cost', fmtMoney(f.cost)],
            ['Avg CPC', fmtMoney(f.averageCpc)],
            ['CTR', f.ctr !== null ? fmtPct(f.ctr, 2) : '-'],
            ['Estimated Conversions', fmtNum(f.conversions)]
          ],
          { title: 'Keyword Planner Traffic & Conversion Forecast' }
        );
      }

      if (action === 'pause_bleeders') {
        const bleeders = kwRows.filter((k) => k.status === 'ENABLED' && k.cost >= 30 && k.conversions === 0);
        if (!bleeders.length) {
          console.log(chalk.green('✔ No enabled keywords found with >= 30 spend and 0 conversions.'));
          continue;
        }
        const selected = await checkbox({
          message: 'Select bleeder keywords to PAUSE:',
          choices: bleeders.map((b) => ({
            name: `${b.text} [${b.matchType}] — Spend: ${fmtMoney(b.cost)}, QS: ${b.qs}, 0 Conv`,
            value: b.criterionResourceName
          }))
        });
        if (!selected.length) continue;
        await this.mutate(
          registry,
          {
            toolName: 'update_entity_status',
            payload: { entity_type: 'AD_GROUP_CRITERION', status: 'PAUSED', resource_names_or_ids: selected },
            summaryTitle: `Pause ${selected.length} Zero-Conversion Keywords`,
            summaryLines: selected.slice(0, 8)
          },
          ctx
        );
      }
    }
  }
}
