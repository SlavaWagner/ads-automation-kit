import chalk from 'chalk';
import { select, checkbox } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

/**
 * Pure deterministic Search Intent Bucketizer + Exact-Match Winner / Junk-Drift Detector.
 */
export function analyzeSearchIntentSignals(searchTermRows = [], keywordRows = []) {
  const kwTextSet = new Set(
    keywordRows.map((k) => String(k.adGroupCriterion?.keyword?.text || '').toLowerCase().trim()).filter(Boolean)
  );

  const infoFreebieRegex = /\b(free|kostenlos|gratis|pdf|template|vorlage|jobs|career|karriere|gehalt|salary|definition|meaning|was ist|wiki|youtube|login)\b/i;
  const commercialRegex = /\b(kaufen|buy|pricing|kosten|preise|agentur|agency|angebot|berater|beratung|quote|anfrage|buchen|service)\b/i;
  const competitorRegex = /\b(vs|alternative|vergleich|erfahrungen|test|review)\b/i;

  const buckets = {
    COMMERCIAL_HIGH_INTENT: [],
    INFO_OR_FREEBIE_DRAIN: [],
    COMPARISON_COMPETITOR: [],
    CLOSE_VARIANT_DRIFT: []
  };

  for (const r of searchTermRows) {
    const term = String(r.searchTermView?.searchTerm || '').trim();
    if (!term) continue;
    const norm = term.toLowerCase();
    const status = r.searchTermView?.status || 'NONE';
    const cost = fromMicros(r.metrics?.costMicros);
    const clicks = Number(r.metrics?.clicks || 0);
    const conv = Number(r.metrics?.conversions || 0);

    const item = { term, status, clicks, cost, conversions: conv, adGroupId: r.adGroup?.id, campaignId: r.campaign?.id };

    if (infoFreebieRegex.test(term) && conv === 0 && status !== 'EXCLUDED') {
      buckets.INFO_OR_FREEBIE_DRAIN.push(item);
    } else if (competitorRegex.test(term)) {
      buckets.COMPARISON_COMPETITOR.push(item);
    } else if (commercialRegex.test(term) || conv >= 1) {
      buckets.COMMERCIAL_HIGH_INTENT.push(item);
    }

    if (status === 'NONE' && !kwTextSet.has(norm) && clicks >= 5 && conv === 0 && cost >= 15) {
      buckets.CLOSE_VARIANT_DRIFT.push(item);
    }
  }

  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => b.cost - a.cost || b.conversions - a.conversions);
  }

  const promoteCandidates = buckets.COMMERCIAL_HIGH_INTENT.filter((x) => x.status === 'NONE' && x.conversions >= 1);
  const excludeCandidates = [...buckets.INFO_OR_FREEBIE_DRAIN, ...buckets.CLOSE_VARIANT_DRIFT]
    .filter((v, idx, arr) => arr.findIndex((o) => o.term === v.term) === idx)
    .sort((a, b) => b.cost - a.cost);

  return { buckets, promoteCandidates, excludeCandidates };
}

export class SearchTermIntelAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'rd-search-term-intel',
      name: 'R&D Search Intent & Close-Variant Drift Agent',
      group: 'RD_INTELLIGENCE',
      sequence: 5,
      category: 'R&D Stage 5 — Search Intent & Close-Variant Drift Control',
      description:
        'Deeply classifies search queries vs active keyword inventory (Commercial Intent vs Informational/Freebie Drain vs Comparison vs Close-Variant Drift), then executes batch Negative Exclusions, Exact Promotions, or PMax Search Theme injections.',
      pairedTools: [
        'report_search_terms',
        'report_keywords',
        'report_shared_sets',
        'exclude_negative_search_terms',
        'create_keywords',
        'attach_audience_targeting'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [stRes, kwRes] = await Promise.all([
      this.invoke(registry, 'report_search_terms', { date_range: dateRange, limit: 500 }, ctx),
      this.invoke(registry, 'report_keywords', { date_range: dateRange, limit: 300 }, ctx).catch(() => ({ results: [] }))
    ]);

    const intel = analyzeSearchIntentSignals(stRes.results || [], kwRes.results || []);
    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, ...intel }, null, 2));
      return { dateRange, ...intel };
    }

    this.printTable(
      ['Intent Cluster', 'Queries', 'Clicks', 'Total Cost', 'Total Conv'],
      Object.entries(intel.buckets).map(([name, list]) => [
        name,
        list.length,
        fmtNum(list.reduce((s, i) => s + i.clicks, 0)),
        fmtMoney(list.reduce((s, i) => s + i.cost, 0)),
        fmtNum(list.reduce((s, i) => s + i.conversions, 0))
      ]),
      { title: `Search Intent Classification (${dateRange})` }
    );

    this.printTable(
      ['Exclusion Candidate', 'Clicks', 'Spend', 'Conv', 'Status'],
      intel.excludeCandidates.slice(0, 15).map((e) => [truncStr(e.term, 38), fmtNum(e.clicks), fmtMoney(e.cost), 0, e.status]),
      { title: 'Top Info/Freebie & Close-Variant Drift Exclusions' }
    );

    this.saveArtifact({ dateRange, promoteCount: intel.promoteCandidates.length, excludeCount: intel.excludeCandidates.length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, ...intel };

    while (true) {
      const action = await select({
        message: 'Search Intent Intel Agent — choose action:',
        choices: [
          { name: `1) Batch Exclude Info/Freebie & Drift Queries (${intel.excludeCandidates.length} candidates)`, value: 'exclude' },
          { name: `2) Promote Unmapped Commercial Winners (${intel.promoteCandidates.length} candidates)`, value: 'promote' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });
      if (action === 'exit') break;

      if (action === 'exclude' && intel.excludeCandidates.length) {
        const picked = await checkbox({
          message: 'Select queries to exclude (EXACT match):',
          choices: intel.excludeCandidates.slice(0, 20).map((e) => ({
            name: `"${e.term}" — ${fmtMoney(e.cost)} spent, 0 conv`,
            value: { text: e.term, match_type: 'EXACT' }
          }))
        });
        if (!picked.length) continue;
        const campId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange, channelType: 'SEARCH' });
        await this.mutate(
          registry,
          {
            toolName: 'exclude_negative_search_terms',
            payload: { scope: 'CAMPAIGN', target_id: campId, keywords: picked },
            summaryTitle: `Exclude ${picked.length} Intent-Drift Terms on Campaign ${campId}`,
            summaryLines: picked.map((p) => `[EXACT] ${p.text}`)
          },
          ctx
        );
      }

      if (action === 'promote' && intel.promoteCandidates.length) {
        const picked = await checkbox({
          message: 'Select Commercial Winners to promote to EXACT keywords (PAUSED):',
          choices: intel.promoteCandidates.slice(0, 20).map((w) => ({
            name: `"${w.term}" — ${w.conversions} conv, ${fmtMoney(w.cost)} spend`,
            value: w
          }))
        });
        if (!picked.length) continue;
        const agId = await this.pickAdGroup(registry, ctx, { allowAll: false, dateRange });
        await this.mutate(
          registry,
          {
            toolName: 'create_keywords',
            payload: { ad_group_id: agId, default_status: 'PAUSED', keywords: picked.map((p) => ({ text: p.term, match_type: 'EXACT', status: 'PAUSED' })) },
            summaryTitle: `Promote ${picked.length} Commercial Winners -> EXACT`,
            summaryLines: picked.map((p) => p.term)
          },
          ctx
        );
      }
    }
  }
}
