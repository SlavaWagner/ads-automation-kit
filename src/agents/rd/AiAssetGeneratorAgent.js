import chalk from 'chalk';
import { select, input, confirm } from '@inquirer/prompts';
import { BaseCliAgent, truncStr } from '../BaseCliAgent.js';
import { sanitizeAdCopy } from '../../safety.js';
import { scrapeLandingPage } from '../../landingPageScraper.js';
import { generateText, hasGeminiKey } from '../../gemini.js';
import { getAngleKnowledgeBase } from '../../memory.js';
import { getConfig } from '../../config.js';

export const PERSUASION_FRAMEWORKS = [
  { id: 'PAS', name: 'PAS (Problem - Agitate - Solve)' },
  { id: '4U', name: '4U (Urgent - Unique - Ultra-Specific - Useful)' },
  { id: 'AIDA', name: 'AIDA (Attention - Interest - Desire - Action)' },
  { id: 'PROOF_FIRST', name: 'Proof-First & Authority Anchoring' },
  { id: 'OBJECTION_DISSOLVER', name: 'Objection Dissolver & Risk Reversal' },
  { id: 'CONTRARIAN', name: 'Contrarian Differentiator' }
];

/**
 * Deterministic fallback composer when running offline/no LLM key so tests & CLI always stay productive.
 */
export function buildDeterministicRsaDraft({ brandOrTopic = 'Expert Service', angleName = 'Fast Relief', finalUrl = '' }) {
  const cleanBrand = String(brandOrTopic).trim().slice(0, 20) || 'Verified';
  const rawHeadlines = [
    `${cleanBrand} Solution`,
    `${angleName.slice(0, 28)}`,
    'Verified Results & Clarity',
    'Transparent Fixed Pricing',
    'Request Free Initial Audit',
    'Certified Specialist Team',
    'Fast Setup Within Days',
    'No Long-Term Contracts'
  ];
  const rawDescriptions = [
    `Discover how ${cleanBrand} solves bottlenecks with measurable precision and clear pricing.`,
    'Trusted by B2B and growth teams. Book your non-binding consultation online today.'
  ];
  return sanitizeAdCopy({ headlines: rawHeadlines, descriptions: rawDescriptions });
}

export class AiAssetGeneratorAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'rd-asset-generator',
      name: 'R&D AI Creative & Persuasion Asset Generator',
      group: 'RD_INTELLIGENCE',
      sequence: 2,
      category: 'R&D Stage 2 — AI Creative & Persuasion Asset Generation',
      description:
        'Combines Angle Discovery Knowledge Base, Search Terms, BEST account assets, and persuasion frameworks (PAS, 4U, AIDA, Proof-First, Objection-Dissolver) to generate policy-sanitized RSAs/Callouts/Sitelinks and stage them as PAUSED.',
      pairedTools: [
        'report_ads',
        'report_assets',
        'report_search_terms',
        'create_ad',
        'create_and_upload_asset',
        'link_assets'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const cid = ctx.customerId || 'default';
    const angleKb = getAngleKnowledgeBase(cid);
    const bestAssetsRes = await this.invoke(registry, 'report_assets', { date_range: 'LAST_30_DAYS', view: 'AD_ASSET_PERFORMANCE', limit: 60 }, ctx).catch(() => ({ results: [] }));
    const bestTexts = (bestAssetsRes.results || [])
      .filter((r) => ['BEST', 'GOOD'].includes(r.adGroupAdAssetView?.performanceLabel))
      .map((r) => r.asset?.textAsset?.text)
      .filter(Boolean);

    if (ctx.nonInteractive) {
      const demo = buildDeterministicRsaDraft({ brandOrTopic: 'Google Ads Audit', angleName: angleKb[0]?.angles?.[0]?.name || 'Verified Clarity' });
      this.saveArtifact({ generatedDraft: demo, kbAnglesUsed: angleKb.length }, true);
      if (ctx.json) console.log(JSON.stringify(demo, null, 2));
      return demo;
    }

    const framework = await select({
      message: 'Select Persuasion / Messaging Framework:',
      choices: PERSUASION_FRAMEWORKS.map((f) => ({ name: f.name, value: f }))
    });

    const finalUrl = await input({ message: 'Target Landing Page URL (https://...):' });
    const angleTopic = await input({
      message: 'Primary Angle or Value Prop focus:',
      default: angleKb[0]?.angles?.[0]?.name || 'High-Precision Specialist Service'
    });

    let scraped = null;
    const scrapeIt = await confirm({ message: 'Scrape Landing Page URL for live message-match proof?', default: true });
    if (scrapeIt) {
      try {
        scraped = await scrapeLandingPage(finalUrl);
        console.log(chalk.green(`✔ Extracted LP title: "${scraped.title}"`));
      } catch (e) {
        console.log(chalk.yellow(`LP scrape skipped: ${e.message}`));
      }
    }

    const cfg = getConfig();
    let draft;
    if (hasGeminiKey(cfg.geminiApiKey) || (await confirm({ message: 'Use Gemini / Antigravity Bridge AI generator (No = deterministic local templates)?', default: true }))) {
      const rawJson = await generateText({
        systemPrompt: `You are an Elite Google Ads Direct-Response Copywriter applying ${framework.name}.\nSTRICT POLICY RULES: Each headline <= 30 chars, each description <= 90 chars, NO exclamation marks, NO trailing periods, NO hype words like Boost/ROI/Guaranteed/Sofort/Jetzt.\nReturn STRICT JSON: { "headlines": string[10], "descriptions": string[4], "callouts": string[4] }`,
        userPrompt: `Target URL: ${finalUrl}\nFocus Angle: ${angleTopic}\nWinning Historical Copy in Account: ${JSON.stringify(bestTexts.slice(0, 10))}\nLanding Page Data: ${JSON.stringify(scraped)}\nAngle Knowledge Base: ${JSON.stringify(angleKb.slice(0, 2))}`,
        jsonMode: true
      });
      const parsed = JSON.parse(rawJson);
      draft = {
        ...sanitizeAdCopy(parsed),
        callouts: (parsed.callouts || []).map((c) => String(c).trim().slice(0, 25)).filter(Boolean)
      };
    } else {
      draft = buildDeterministicRsaDraft({ brandOrTopic: scraped?.title || angleTopic, angleName: angleTopic, finalUrl });
    }

    console.log(chalk.bold.cyan(`\nGenerated Sanitized Copy (${framework.id}):`));
    this.printTable(
      ['Headlines (<=30 chars)', 'Len'],
      draft.headlines.map((h) => [h, h.length]),
      { title: 'Drafted RSA Headlines' }
    );
    this.printTable(
      ['Descriptions (<=90 chars)', 'Len'],
      draft.descriptions.map((d) => [truncStr(d, 72), d.length]),
      { title: 'Drafted RSA Descriptions' }
    );

    this.saveArtifact({ framework: framework.id, finalUrl, angleTopic, draft });

    const dest = await select({
      message: 'What do you want to stage in Google Ads?',
      choices: [
        { name: '1) Stage as a new PAUSED Responsive Search Ad in an Ad Group (create_ad)', value: 'rsa' },
        { name: '2) Upload Callout Asset & Link to a Campaign', value: 'callout' },
        { name: '3) Finish without uploading', value: 'done' }
      ]
    });

    if (dest === 'rsa') {
      const agId = await this.pickAdGroup(registry, ctx, { allowAll: false });
      await this.mutate(
        registry,
        {
          toolName: 'create_ad',
          payload: {
            ad_group_id: agId,
            ad_type: 'RESPONSIVE_SEARCH_AD',
            status: 'PAUSED',
            final_urls: [finalUrl],
            headlines: draft.headlines.slice(0, 15),
            descriptions: draft.descriptions.slice(0, 4)
          },
          summaryTitle: `Stage PAUSED RSA [${framework.id}] -> Ad Group ${agId}`,
          summaryLines: [`URL: ${finalUrl}`, `Headlines: ${draft.headlines.slice(0, 4).join(' | ')}`]
        },
        ctx
      );
    } else if (dest === 'callout' && draft.callouts?.length) {
      const text = await select({ message: 'Select Callout to create:', choices: draft.callouts.map((c) => ({ name: c, value: c })) });
      await this.mutate(
        registry,
        {
          toolName: 'create_and_upload_asset',
          payload: { asset_type: 'CALLOUT', callout_text: text },
          summaryTitle: `Upload Callout Asset "${text}"`,
          summaryLines: [`Text : ${text}`]
        },
        ctx
      );
    }
  }
}
