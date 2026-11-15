import chalk from 'chalk';
import { select, checkbox } from '@inquirer/prompts';
import { BaseCliAgent, truncStr } from '../BaseCliAgent.js';

export class RecommendationsAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'recommendations',
      name: 'Recommendations, Optimization Score & Policy Agent',
      group: 'MCP_PAIRED',
      sequence: 15,
      category: 'Recommendations & Policy',
      description:
        'Reviews account Optimization Score, active Google Ads Recommendations, and Policy Disapproval alerts; lets you selectively APPLY or DISMISS recommendations with full preview and confirmation.',
      pairedTools: [
        'report_recommendations',
        'report_policy_diagnostics',
        'get_customer_info',
        'apply_or_dismiss_recommendation'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);

    const [custRes, recRes, polRes] = await Promise.all([
      this.invoke(registry, 'get_customer_info', {}, ctx).catch(() => ({ results: [] })),
      this.invoke(registry, 'report_recommendations', { limit: 100 }, ctx),
      this.invoke(registry, 'report_policy_diagnostics', { limit: 100 }, ctx).catch(() => ({ disapprovedOrLimitedAds: [] }))
    ]);

    const optScore = custRes.results?.[0]?.customer?.optimizationScore;
    const recs = (recRes.results || []).map((r) => ({
      resourceName: r.recommendation?.resourceName,
      type: r.recommendation?.type || 'UNKNOWN',
      campaignName: r.campaign?.name || 'Account-level',
      impact: r.recommendation?.impact || null
    }));

    if (ctx.json) {
      console.log(JSON.stringify({ optimizationScore: optScore, recommendations: recs, policyIssues: polRes.disapprovedOrLimitedAds || [] }, null, 2));
      return { optimizationScore: optScore, recommendations: recs };
    }

    if (optScore !== undefined) {
      console.log(chalk.cyan(`Account Optimization Score: ${(Number(optScore) * 100).toFixed(1)}%\n`));
    }

    this.printTable(
      ['#', 'Recommendation Type', 'Campaign', 'Resource Name'],
      recs.slice(0, 30).map((r, i) => [
        i + 1,
        r.type,
        truncStr(r.campaignName, 26),
        truncStr(r.resourceName, 42)
      ]),
      { title: 'Active Google Ads Recommendations' }
    );

    if ((polRes.disapprovedOrLimitedAds || []).length) {
      console.log(chalk.red(`⚠ ${polRes.disapprovedOrLimitedAds.length} policy issues found across active/paused ads.`));
    }

    this.saveArtifact({ optimizationScore: optScore, recommendationsCount: recs.length }, ctx.nonInteractive);
    if (ctx.nonInteractive || !recs.length) return { optimizationScore: optScore, recommendations: recs };

    const mode = await select({
      message: 'Recommendations Agent — choose action:',
      choices: [
        { name: '1) DISMISS unwanted Recommendations (e.g. Broad Match / Auto-Apply Noise)', value: 'DISMISS' },
        { name: '2) APPLY selected Recommendations', value: 'APPLY' },
        { name: 'Back to Main Menu', value: 'exit' }
      ]
    });

    if (mode === 'exit') return;

    const picked = await checkbox({
      message: `Select recommendations to ${mode}:`,
      choices: recs.slice(0, 25).map((r) => ({
        name: `[${r.type}] ${r.campaignName} (${r.resourceName})`,
        value: r.resourceName
      }))
    });

    if (!picked.length) return;

    await this.mutate(
      registry,
      {
        toolName: 'apply_or_dismiss_recommendation',
        payload: { action: mode, recommendation_resource_names: picked },
        summaryTitle: `${mode} ${picked.length} Google Ads Recommendation(s)`,
        summaryLines: picked.slice(0, 10)
      },
      ctx
    );
  }
}
