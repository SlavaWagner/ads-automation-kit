import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';
import { scrapeLandingPage } from '../../landingPageScraper.js';
import { generateText } from '../../gemini.js';
import { saveAngleKnowledgeEntry, getAngleKnowledgeBase } from '../../memory.js';

/**
 * Pure deterministic Search Term & Asset Angle Classifier.
 */
export function mineIntentAngleClusters(searchTermRows = [], assetRows = []) {
  const archetypes = {
    PAIN_PROBLEM: /\b(problem|error|fix|broken|slow|issue|fail|costly|expensive|stuck|schaden|problem|fehler|teuer)\b/i,
    OBJECTION_COMPARISON: /\b(vs|alternative|compare|review|test|vergleich|erfahrung|seriös|kosten|price|pricing|fee)\b/i,
    OUTCOME_SOLUTION: /\b(best|top|service|agency|software|solution|beratung|bewertung|expert|certified|audit)\b/i,
    URGENCY_ACTION: /\b(now|today|fast|quick|near me|sofort|heute|schnell|termin|angebot|quote)\b/i
  };

  const buckets = {
    PAIN_PROBLEM: [],
    OBJECTION_COMPARISON: [],
    OUTCOME_SOLUTION: [],
    URGENCY_ACTION: []
  };

  for (const r of searchTermRows) {
    const term = String(r.searchTermView?.searchTerm || '').trim();
    if (!term) continue;
    const clicks = Number(r.metrics?.clicks || 0);
    const conv = Number(r.metrics?.conversions || 0);
    const cost = fromMicros(r.metrics?.costMicros);

    for (const [bucketName, regex] of Object.entries(archetypes)) {
      if (regex.test(term)) {
        buckets[bucketName].push({ term, clicks, conv, cost });
      }
    }
  }

  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => b.conv - a.conv || b.clicks - a.clicks);
  }

  const bestAssets = assetRows
    .filter((r) => ['BEST', 'GOOD'].includes(r.adGroupAdAssetView?.performanceLabel))
    .map((r) => ({
      fieldType: r.adGroupAdAssetView?.fieldType,
      label: r.adGroupAdAssetView?.performanceLabel,
      text: r.asset?.textAsset?.text || '-',
      impressions: Number(r.metrics?.impressions || 0),
      clicks: Number(r.metrics?.clicks || 0)
    }));

  const summary = Object.entries(buckets).map(([angle, items]) => ({
    angle,
    queryCount: items.length,
    totalClicks: items.reduce((s, i) => s + i.clicks, 0),
    totalConversions: items.reduce((s, i) => s + i.conv, 0),
    topExamples: items.slice(0, 5).map((i) => i.term)
  }));

  return { buckets, summary, bestAssets };
}

export class AngleDiscoveryAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'rd-angle-discovery',
      name: 'R&D Angle Discovery & Intent Mining Agent',
      group: 'RD_INTELLIGENCE',
      sequence: 1,
      category: 'R&D Stage 1 — Angle Discovery & Intent Mining',
      description:
        'Mines winning messaging angles from live Search Terms, Keyword performance, BEST-labeled Ad Assets, Keyword Planner ideas, and Landing Page scraping, then persists verified Angles to Episodic Memory for downstream Asset Generation.',
      pairedTools: [
        'report_search_terms',
        'report_keywords',
        'report_ads',
        'report_assets',
        'keyword_planner_generate_ideas'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [stRes, assetRes, kwRes] = await Promise.all([
      this.invoke(registry, 'report_search_terms', { date_range: dateRange, limit: 350 }, ctx),
      this.invoke(registry, 'report_assets', { date_range: dateRange, view: 'AD_ASSET_PERFORMANCE', limit: 200 }, ctx).catch(() => ({ results: [] })),
      this.invoke(registry, 'report_keywords', { date_range: dateRange, limit: 150 }, ctx).catch(() => ({ results: [] }))
    ]);

    const mined = mineIntentAngleClusters(stRes.results || [], assetRes.results || []);
    const cid = stRes.customerId || ctx.customerId || 'default';

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, ...mined, keywordCount: (kwRes.results || []).length }, null, 2));
      return { dateRange, ...mined };
    }

    this.printTable(
      ['Intent Angle Archetype', 'Queries', 'Clicks', 'Conversions', 'Top Sample Terms'],
      mined.summary.map((s) => [
        s.angle,
        s.queryCount,
        fmtNum(s.totalClicks),
        fmtNum(s.totalConversions),
        truncStr(s.topExamples.join(', ') || '-', 42)
      ]),
      { title: `Discovered Search Intent Angle Clusters (${dateRange})` }
    );

    if (mined.bestAssets.length) {
      this.printTable(
        ['Field Type', 'Google Label', 'Winning Copy Asset', 'Clicks'],
        mined.bestAssets.slice(0, 15).map((a) => [a.fieldType, a.label, truncStr(a.text, 44), fmtNum(a.clicks)]),
        { title: 'Proven BEST / GOOD Ad Copy Assets in Account' }
      );
    }

    this.saveArtifact({ dateRange, summary: mined.summary, bestAssetsCount: mined.bestAssets.length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, ...mined };

    while (true) {
      const action = await select({
        message: 'Angle Discovery Agent — choose next step:',
        choices: [
          { name: '1) Scrape Landing Page & Synthesize New Messaging Angles -> Save to Knowledge Base', value: 'synthesize' },
          { name: '2) Expand Demand Seed Angles via Keyword Planner', value: 'planner' },
          { name: '3) View Saved Angle Knowledge Base (Episodic Memory)', value: 'kb' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'kb') {
        const entries = getAngleKnowledgeBase(cid);
        console.log(chalk.cyan(`\n${entries.length} angle discovery snapshot(s) saved for ${cid}:`));
        console.log(JSON.stringify(entries.slice(0, 5), null, 2));
      }

      if (action === 'planner') {
        const seed = await input({ message: 'Seed topic for angle expansion:' });
        const pRes = await this.invoke(registry, 'keyword_planner_generate_ideas', { seed_keywords: [seed], page_size: 40 }, ctx);
        this.printTable(
          ['Related Demand Angle', 'Monthly Vol', 'Comp', 'High Bid'],
          (pRes.ideas || []).slice(0, 20).map((i) => [
            truncStr(i.text, 36),
            fmtNum(i.metrics?.avgMonthlySearches),
            i.metrics?.competition || '-',
            fmtMoney(i.metrics?.highTopOfPageBid)
          ]),
          { title: `Keyword Planner Demand Angles for "${seed}"` }
        );
      }

      if (action === 'synthesize') {
        const url = await input({ message: 'Landing Page URL to inspect (optional, blank to use API signals only):', default: '' });
        let pageData = null;
        if (url.trim()) {
          try {
            pageData = await scrapeLandingPage(url.trim());
            console.log(chalk.green(`✔ Scraped "${pageData.title}" (${pageData.headings?.length || 0} headings)`));
          } catch (err) {
            console.log(chalk.yellow(`Scrape warning: ${err.message}`));
          }
        }

        const aiText = await generateText({
          systemPrompt:
            'You are an R&D Angle Strategist for Google Ads. Return STRICT JSON ONLY: { "angles": [{ "name": string, "corePainOrDesire": string, "objectionToDissolve": string, "proofMechanism": string, "sampleHooks": string[] }] }.',
          userPrompt: `Synthesize 4 high-converting messaging angles grounded in these Google Ads signals and landing page:\nIntent Clusters:\n${JSON.stringify(mined.summary, null, 2)}\nBEST Assets:\n${JSON.stringify(mined.bestAssets.slice(0, 12), null, 2)}\nLanding Page:\n${JSON.stringify(pageData, null, 2)}`,
          jsonMode: true
        });

        const parsed = JSON.parse(aiText);
        saveAngleKnowledgeEntry(cid, { sourceUrl: url || null, summary: mined.summary, angles: parsed.angles || [] });
        console.log(chalk.bold.green('\n✔ Synthesized & saved new Angles to Episodic Memory Knowledge Base:'));
        console.log(JSON.stringify(parsed.angles || [], null, 2));
      }
    }
  }
}
