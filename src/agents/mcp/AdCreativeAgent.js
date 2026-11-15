import chalk from 'chalk';
import { select, input, confirm } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';
import { scrapeLandingPage } from '../../landingPageScraper.js';
import { generateText } from '../../gemini.js';
import { sanitizeAdCopy } from '../../safety.js';

export class AdCreativeAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'ad-creative',
      name: 'Ad Copy, Policy & RSA Mutation Agent',
      group: 'MCP_PAIRED',
      sequence: 6,
      category: 'Creatives & Copy',
      description:
        'Audits Ads across Search/Display/Demand Gen (Ad Strength, Policy approval status, Landing Page speed), scrapes landing pages to draft policy-compliant RSAs, creates new Ads (PAUSED), updates copy/URLs, and toggles status.',
      pairedTools: [
        'report_ads',
        'report_policy_diagnostics',
        'report_landing_pages',
        'create_ad',
        'update_ad',
        'update_entity_status'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');
    const campaignId = await this.pickCampaign(registry, ctx, { allowAll: true, dateRange });

    const [adsRes, policyRes, lpRes] = await Promise.all([
      this.invoke(registry, 'report_ads', { date_range: dateRange, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 150 }, ctx),
      this.invoke(registry, 'report_policy_diagnostics', { limit: 100 }, ctx).catch(() => ({ disapprovedOrLimitedAds: [] })),
      this.invoke(registry, 'report_landing_pages', { date_range: dateRange, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 50 }, ctx).catch(() => ({ results: [] }))
    ]);

    const ads = (adsRes.results || []).map((r) => {
      const aga = r.adGroupAd || {};
      const ad = aga.ad || {};
      const m = r.metrics || {};
      const cost = fromMicros(m.costMicros);
      const conv = Number(m.conversions || 0);
      return {
        campaignId: r.campaign?.id,
        campaignName: r.campaign?.name || '-',
        adGroupId: r.adGroup?.id,
        adGroupName: r.adGroup?.name || '-',
        adId: ad.id,
        resourceName: `customers/${adsRes.customerId}/adGroupAds/${r.adGroup?.id}~${ad.id}`,
        type: ad.type,
        status: aga.status,
        adStrength: aga.adStrength || '-',
        approval: aga.policySummary?.approvalStatus || '-',
        finalUrl: ad.finalUrls?.[0] || '-',
        impressions: Number(m.impressions || 0),
        clicks: Number(m.clicks || 0),
        ctr: Number(m.ctr || 0),
        cost,
        conversions: conv
      };
    });

    const policyIssues = policyRes.disapprovedOrLimitedAds || [];
    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, ads, policyIssues, landingPages: lpRes.results || [] }, null, 2));
      return { dateRange, ads, policyIssues };
    }

    this.printTable(
      ['Ad ID', 'Ad Group', 'Type', 'Status', 'Strength', 'Policy', 'Impr', 'CTR', 'Spend', 'Conv'],
      ads.map((a) => [
        a.adId,
        truncStr(a.adGroupName, 22),
        truncStr(a.type, 16),
        a.status,
        a.adStrength,
        a.approval,
        fmtNum(a.impressions),
        fmtPct(a.ctr, 2),
        fmtMoney(a.cost),
        fmtNum(a.conversions)
      ]),
      { title: `Ad Performance & Ad Strength Report (${dateRange})` }
    );

    if (policyIssues.length) {
      console.log(chalk.red(`⚠ ${policyIssues.length} ads have non-APPROVED policy statuses.`));
    }

    this.saveArtifact({ dateRange, adsCount: ads.length, policyIssuesCount: policyIssues.length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, ads, policyIssues };

    while (true) {
      const action = await select({
        message: 'Ad Creative Agent — choose action:',
        choices: [
          { name: '1) Draft & Create New Responsive Search Ad (RSA) from Landing Page URL', value: 'create_rsa' },
          { name: '2) Update Existing Ad Copy / Final URLs (update_ad)', value: 'update_ad' },
          { name: '3) Pause / Enable Ad (update_entity_status)', value: 'status' },
          { name: '4) Inspect Landing Page Speed & Mobile Readiness Report', value: 'lp' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'lp') {
        const lpRows = (lpRes.results || []).map((r) => [
          truncStr(r.landingPageView?.unexpandedFinalUrl || '-', 42),
          r.metrics?.speedScore ?? '-',
          r.metrics?.mobileFriendlyClicksPercentage !== undefined ? fmtPct(r.metrics.mobileFriendlyClicksPercentage, 0) : '-',
          fmtNum(r.metrics?.clicks),
          fmtMoney(fromMicros(r.metrics?.costMicros)),
          fmtNum(r.metrics?.conversions)
        ]);
        this.printTable(['Landing Page URL', 'Speed', 'Mobile%', 'Clicks', 'Spend', 'Conv'], lpRows, {
          title: 'Landing Page Experience Report'
        });
      }

      if (action === 'create_rsa') {
        const agId = await this.pickAdGroup(registry, ctx, { campaignId, allowAll: false, dateRange });
        const finalUrl = await input({ message: 'Final Landing Page URL (https://...):' });
        const useAiDraft = await confirm({
          message: 'Scrape landing page & generate RSA headlines/descriptions via Gemini / Antigravity Bridge?',
          default: true
        });

        let clean;
        if (useAiDraft) {
          let scraped = {};
          try {
            scraped = await scrapeLandingPage(finalUrl);
            console.log(chalk.cyan(`Scraped "${scraped.title}" (${scraped.headings?.length || 0} headings)`));
          } catch (e) {
            console.log(chalk.yellow(`Landing page scrape warning: ${e.message}`));
          }
          const rawJson = await generateText({
            systemPrompt:
              'You are a Senior Google Ads Copywriter. Return STRICT JSON ONLY: { "headlines": string[8..12] (each <=30 chars, no exclamation marks), "descriptions": string[4] (each <=90 chars, no exclamation marks or trailing periods) }.',
            userPrompt: `Create high-CTR, policy-compliant RSA copy for URL: ${finalUrl}\nScraped Context:\n${JSON.stringify(scraped, null, 2)}`,
            jsonMode: true
          });
          const parsed = JSON.parse(rawJson);
          clean = sanitizeAdCopy(parsed);
        } else {
          const hRaw = await input({ message: 'Enter 3-15 headlines separated by | (max 30 chars each):' });
          const dRaw = await input({ message: 'Enter 2-4 descriptions separated by | (max 90 chars each):' });
          clean = sanitizeAdCopy({
            headlines: hRaw.split('|').map((s) => s.trim()).filter(Boolean),
            descriptions: dRaw.split('|').map((s) => s.trim()).filter(Boolean)
          });
        }

        if (clean.headlines.length < 3 || clean.descriptions.length < 2) {
          console.log(chalk.red('Insufficient valid headlines (min 3) or descriptions (min 2) after sanitization.'));
          continue;
        }

        await this.mutate(
          registry,
          {
            toolName: 'create_ad',
            payload: {
              ad_group_id: agId,
              ad_type: 'RESPONSIVE_SEARCH_AD',
              status: 'PAUSED',
              final_urls: [finalUrl],
              headlines: clean.headlines.slice(0, 15),
              descriptions: clean.descriptions.slice(0, 4)
            },
            summaryTitle: `Create PAUSED RSA in Ad Group ${agId}`,
            summaryLines: [
              `Final URL    : ${finalUrl}`,
              `Headlines    : ${clean.headlines.slice(0, 5).join(' | ')} (${clean.headlines.length} total)`,
              `Descriptions : ${clean.descriptions.slice(0, 2).join(' | ')}`
            ]
          },
          ctx
        );
      }

      if (action === 'update_ad') {
        const adId = await input({ message: 'Enter Ad ID to update:' });
        const newUrl = await input({ message: 'New Final URL (leave blank to keep existing):', default: '' });
        const hRaw = await input({ message: 'New headlines separated by | (blank to keep existing):', default: '' });
        const dRaw = await input({ message: 'New descriptions separated by | (blank to keep existing):', default: '' });
        const sanitized = sanitizeAdCopy({
          headlines: hRaw ? hRaw.split('|').map((s) => s.trim()).filter(Boolean) : [],
          descriptions: dRaw ? dRaw.split('|').map((s) => s.trim()).filter(Boolean) : []
        });
        const payload = {
          ad_id: adId,
          ...(newUrl.trim() ? { final_urls: [newUrl.trim()] } : {}),
          ...(sanitized.headlines.length ? { headlines: sanitized.headlines } : {}),
          ...(sanitized.descriptions.length ? { descriptions: sanitized.descriptions } : {})
        };
        await this.mutate(
          registry,
          {
            toolName: 'update_ad',
            payload,
            summaryTitle: `Update Ad ${adId}`,
            summaryLines: Object.keys(payload).map((k) => `${k}: ${JSON.stringify(payload[k]).slice(0, 60)}`)
          },
          ctx
        );
      }

      if (action === 'status') {
        if (!ads.length) {
          console.log(chalk.yellow('No ads loaded to toggle.'));
          continue;
        }
        const pickedRn = await select({
          message: 'Select Ad to Enable or Pause:',
          choices: ads.slice(0, 40).map((a) => ({
            name: `[${a.adId}] ${truncStr(a.adGroupName, 22)} | ${a.status} | Spend ${fmtMoney(a.cost)} | Conv ${fmtNum(a.conversions)}`,
            value: a.resourceName
          }))
        });
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
            payload: { entity_type: 'AD_GROUP_AD', status, resource_names_or_ids: [pickedRn] },
            summaryTitle: `Set Ad Status -> ${status}`,
            summaryLines: [`Resource : ${pickedRn}`, `Status   : ${status}`]
          },
          ctx
        );
      }
    }
  }
}
