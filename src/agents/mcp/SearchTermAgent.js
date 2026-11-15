import chalk from 'chalk';
import { select, input, checkbox } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

/**
 * Pure deterministic Search Term N-Gram Waste & Winner Analyzer.
 */
export function analyzeSearchTermsNGrams(rows = [], { minSpendWaste = 15, minConversionsWin = 1 } = {}) {
  const ngramMap = new Map();
  const singleWasteTerms = [];
  const convertingAdditions = [];

  for (const r of rows) {
    const term = String(r.searchTermView?.searchTerm || '').trim();
    if (!term) continue;
    const status = r.searchTermView?.status || 'NONE';
    const cost = fromMicros(r.metrics?.costMicros);
    const clicks = Number(r.metrics?.clicks || 0);
    const impressions = Number(r.metrics?.impressions || 0);
    const conversions = Number(r.metrics?.conversions || 0);

    if (conversions === 0 && cost >= minSpendWaste && status !== 'EXCLUDED') {
      singleWasteTerms.push({
        searchTerm: term,
        campaignId: r.campaign?.id,
        campaignName: r.campaign?.name,
        adGroupId: r.adGroup?.id,
        status,
        clicks,
        cost
      });
    }

    if (conversions >= minConversionsWin && status === 'NONE') {
      convertingAdditions.push({
        searchTerm: term,
        campaignId: r.campaign?.id,
        campaignName: r.campaign?.name,
        adGroupId: r.adGroup?.id,
        clicks,
        cost,
        conversions,
        cpa: cost / conversions
      });
    }

    const tokens = term
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    const grams = new Set();
    for (let i = 0; i < tokens.length; i++) {
      grams.add(tokens[i]);
      if (i + 1 < tokens.length) grams.add(`${tokens[i]} ${tokens[i + 1]}`);
    }

    for (const g of grams) {
      if (!ngramMap.has(g)) {
        ngramMap.set(g, { ngram: g, termCount: 0, impressions: 0, clicks: 0, cost: 0, conversions: 0 });
      }
      const agg = ngramMap.get(g);
      agg.termCount += 1;
      agg.impressions += impressions;
      agg.clicks += clicks;
      agg.cost += cost;
      agg.conversions += conversions;
    }
  }

  const wastedNGrams = Array.from(ngramMap.values())
    .filter((n) => n.conversions === 0 && n.cost >= minSpendWaste)
    .sort((a, b) => b.cost - a.cost);

  return {
    singleWasteTerms: singleWasteTerms.sort((a, b) => b.cost - a.cost),
    wastedNGrams,
    convertingAdditions: convertingAdditions.sort((a, b) => b.conversions - a.conversions || a.cpa - b.cpa)
  };
}

export class SearchTermAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'search-term',
      name: 'Search Term N-Gram Miner & Negative Exclusion Agent',
      group: 'MCP_PAIRED',
      sequence: 5,
      category: 'Search Intelligence',
      description:
        'Analyzes actual user search queries, clusters 1-gram/2-gram wasted spend, proposes exact/phrase negative exclusions across 4 scopes (Ad Group, Campaign, Shared Set, Account), and promotes converting NONE terms into Exact keywords.',
      pairedTools: [
        'report_search_terms',
        'report_shared_sets',
        'exclude_negative_search_terms',
        'create_keywords',
        'manage_shared_sets'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');
    const campaignId = await this.pickCampaign(registry, ctx, { allowAll: true, dateRange, channelType: 'SEARCH' });

    const [stRes, ssRes] = await Promise.all([
      this.invoke(registry, 'report_search_terms', { date_range: dateRange, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 500 }, ctx),
      this.invoke(registry, 'report_shared_sets', { limit: 100 }, ctx).catch(() => ({ sharedSets: [] }))
    ]);

    const analysis = analyzeSearchTermsNGrams(stRes.results || []);
    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, ...analysis }, null, 2));
      return { dateRange, ...analysis };
    }

    this.printTable(
      ['Wasted N-Gram', 'Matching Terms', 'Clicks', 'Wasted Spend', 'Conversions'],
      analysis.wastedNGrams.slice(0, 20).map((n) => [
        truncStr(n.ngram, 32),
        n.termCount,
        fmtNum(n.clicks),
        fmtMoney(n.cost),
        0
      ]),
      { title: `Top Zero-Conversion N-Gram Spend Wasters (${dateRange})` }
    );

    this.printTable(
      ['Converting Search Term (NONE)', 'Campaign', 'Clicks', 'Conv', 'Cost', 'CPA'],
      analysis.convertingAdditions.slice(0, 15).map((w) => [
        truncStr(w.searchTerm, 34),
        truncStr(w.campaignName, 20),
        fmtNum(w.clicks),
        fmtNum(w.conversions),
        fmtMoney(w.cost),
        fmtMoney(w.cpa)
      ]),
      { title: 'Untapped Converting Search Terms (Promote to Exact)' }
    );

    this.saveArtifact({ dateRange, counts: { waste: analysis.singleWasteTerms.length, ngrams: analysis.wastedNGrams.length, winners: analysis.convertingAdditions.length } }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, ...analysis };

    while (true) {
      const action = await select({
        message: 'Search Term Agent — choose action:',
        choices: [
          { name: '1) Exclude Negative Search Terms / Wasted N-Grams', value: 'exclude' },
          { name: '2) Promote Converting "NONE" Search Terms -> Exact Match Keywords', value: 'promote' },
          { name: '3) Create / Link Shared Negative Keyword List (manage_shared_sets)', value: 'shared' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'exclude') {
        const candidates = [
          ...analysis.wastedNGrams.slice(0, 12).map((n) => ({ name: `[N-GRAM] "${n.ngram}" — ${fmtMoney(n.cost)} wasted, 0 conv`, value: { text: n.ngram, match_type: 'PHRASE' } })),
          ...analysis.singleWasteTerms.slice(0, 15).map((t) => ({ name: `[TERM] "${t.searchTerm}" — ${fmtMoney(t.cost)} wasted, 0 conv`, value: { text: t.searchTerm, match_type: 'EXACT' } }))
        ];
        if (!candidates.length) {
          console.log(chalk.green('✔ No high-waste search terms found above threshold.'));
          continue;
        }
        const picked = await checkbox({ message: 'Select terms/n-grams to exclude:', choices: candidates });
        if (!picked.length) continue;

        const scope = await select({
          message: 'Exclusion scope:',
          choices: [
            { name: 'CAMPAIGN (Recommended default)', value: 'CAMPAIGN' },
            { name: 'AD_GROUP', value: 'AD_GROUP' },
            { name: 'SHARED_SET (Negative Keyword List)', value: 'SHARED_SET' },
            { name: 'ACCOUNT (customerNegativeCriteria)', value: 'ACCOUNT' }
          ]
        });
        let targetId;
        if (scope === 'CAMPAIGN') targetId = campaignId || (await this.pickCampaign(registry, ctx, { allowAll: false, dateRange }));
        else if (scope === 'AD_GROUP') targetId = await this.pickAdGroup(registry, ctx, { campaignId, allowAll: false, dateRange });
        else if (scope === 'SHARED_SET') {
          const sets = (ssRes.sharedSets || []).filter((s) => s.sharedSet?.type === 'NEGATIVE_KEYWORDS');
          if (sets.length) {
            targetId = await select({
              message: 'Select Negative Keyword Shared Set:',
              choices: sets.map((s) => ({ name: `${s.sharedSet.name} (ID: ${s.sharedSet.id})`, value: String(s.sharedSet.id) }))
            });
          } else {
            targetId = await input({ message: 'Shared Set ID:' });
          }
        }

        await this.mutate(
          registry,
          {
            toolName: 'exclude_negative_search_terms',
            payload: { scope, ...(targetId ? { target_id: targetId } : {}), keywords: picked },
            summaryTitle: `Exclude ${picked.length} Negative Terms (${scope})`,
            summaryLines: picked.slice(0, 10).map((k) => `[${k.match_type}] ${k.text}`)
          },
          ctx
        );
      }

      if (action === 'promote') {
        if (!analysis.convertingAdditions.length) {
          console.log(chalk.yellow('No converting NONE search terms available to promote.'));
          continue;
        }
        const picked = await checkbox({
          message: 'Select converting queries to add as EXACT keywords (staged PAUSED):',
          choices: analysis.convertingAdditions.slice(0, 20).map((w) => ({
            name: `${w.searchTerm} (Conv: ${w.conversions}, CPA: ${fmtMoney(w.cpa)})`,
            value: w
          }))
        });
        if (!picked.length) continue;
        const targetAgId = await this.pickAdGroup(registry, ctx, { campaignId, allowAll: false, dateRange });
        await this.mutate(
          registry,
          {
            toolName: 'create_keywords',
            payload: {
              ad_group_id: targetAgId,
              default_status: 'PAUSED',
              keywords: picked.map((w) => ({ text: w.searchTerm, match_type: 'EXACT', status: 'PAUSED' }))
            },
            summaryTitle: `Promote ${picked.length} Winning Search Terms -> Exact Match`,
            summaryLines: [`Ad Group : ${targetAgId}`, ...picked.map((w) => `[EXACT] ${w.searchTerm}`)]
          },
          ctx
        );
      }

      if (action === 'shared') {
        const listName = await input({ message: 'New Shared Negative Keyword List name:' });
        await this.mutate(
          registry,
          {
            toolName: 'manage_shared_sets',
            payload: { action: 'CREATE_SHARED_SET', name: listName, type: 'NEGATIVE_KEYWORDS' },
            summaryTitle: `Create Negative Keyword Shared Set "${listName}"`,
            summaryLines: [`Name : ${listName}`, 'Type : NEGATIVE_KEYWORDS']
          },
          ctx
        );
      }
    }
  }
}
