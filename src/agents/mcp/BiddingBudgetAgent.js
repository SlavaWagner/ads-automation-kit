import { select, input } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtPct, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export class BiddingBudgetAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'bidding-budget',
      name: 'Bidding, Budgets, Target CPA & Target ROAS Agent',
      group: 'MCP_PAIRED',
      sequence: 12,
      category: 'Bidding & Budgets',
      description:
        'Audits CampaignBudgets (including Google recommended budgets & Budget Lost Impression Share) and Portfolio Bidding Strategies; adjusts Target CPA/ROAS, creates/updates Budgets, switches bidding strategies, or creates Portfolio Strategies.',
      pairedTools: [
        'report_budgets_and_bidding',
        'report_campaigns',
        'report_impression_share',
        'adjust_target_cpa',
        'adjust_target_roas',
        'create_budget_and_adjust_bidding',
        'create_portfolio_bidding_strategy'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [bbRes, campRes, isRes] = await Promise.all([
      this.invoke(registry, 'report_budgets_and_bidding', { limit: 150 }, ctx),
      this.invoke(registry, 'report_campaigns', { date_range: dateRange, limit: 150 }, ctx),
      this.invoke(registry, 'report_impression_share', { date_range: dateRange, level: 'CAMPAIGN', limit: 150 }, ctx).catch(() => ({ results: [] }))
    ]);

    const budgets = bbRes.campaignBudgets || [];
    const portfolios = bbRes.portfolioBiddingStrategies || [];
    const isMap = new Map((isRes.results || []).map((r) => [String(r.campaign?.id), r.metrics || {}]));

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, budgets, portfolios, campaigns: campRes.results || [] }, null, 2));
      return { dateRange, budgets, portfolios };
    }

    this.printTable(
      ['Budget ID', 'Budget Name', 'Daily Amount', 'Shared', 'Refs', 'Rec Budget'],
      budgets.map((b) => {
        const cb = b.campaignBudget || {};
        return [
          cb.id || '-',
          truncStr(cb.name || '-', 28),
          fmtMoney(fromMicros(cb.amountMicros)),
          cb.explicitlyShared ? 'Yes' : 'No',
          cb.referenceCount ?? 0,
          cb.hasRecommendedBudget ? fmtMoney(fromMicros(cb.recommendedBudgetAmountMicros)) : '-'
        ];
      }),
      { title: 'Campaign Budgets Inventory' }
    );

    this.printTable(
      ['Camp ID', 'Campaign', 'Bidding', 'Budget/d', 'Target CPA', 'Target ROAS', 'Budget Lost IS'],
      (campRes.results || []).map((r) => {
        const c = r.campaign || {};
        const ism = isMap.get(String(c.id)) || {};
        const tcpa = fromMicros(c.maximizeConversions?.targetCpaMicros || c.targetCpa?.targetCpaMicros);
        const troas = c.maximizeConversionValue?.targetRoas || c.targetRoas?.targetRoas || 0;
        return [
          c.id,
          truncStr(c.name, 26),
          c.biddingStrategyType || '-',
          fmtMoney(r.computed?.budgetDaily),
          tcpa ? fmtMoney(tcpa) : '-',
          troas ? `${Number(troas).toFixed(2)}x` : '-',
          fmtPct(ism.searchBudgetLostImpressionShare, 1)
        ];
      }),
      { title: `Campaign Bidding & Target Calibration (${dateRange})` }
    );

    this.saveArtifact({ dateRange, budgetsCount: budgets.length, portfolioCount: portfolios.length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, budgets, portfolios };

    while (true) {
      const action = await select({
        message: 'Bidding & Budget Agent — choose action:',
        choices: [
          { name: '1) Adjust Campaign Target CPA (adjust_target_cpa)', value: 'tcpa' },
          { name: '2) Adjust Campaign Target ROAS (adjust_target_roas)', value: 'troas' },
          { name: '3) Update Existing Daily Budget Amount (UPDATE_BUDGET)', value: 'update_budget' },
          { name: '4) Create New Budget & Assign to Campaign', value: 'new_budget' },
          { name: '5) Switch Campaign Bidding Strategy', value: 'switch_bidding' },
          { name: '6) Create Shared Portfolio Bidding Strategy', value: 'portfolio' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'tcpa') {
        const campId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange });
        const targetCpa = Number(await input({ message: 'New Target CPA (account currency):' }));
        await this.mutate(
          registry,
          {
            toolName: 'adjust_target_cpa',
            payload: { level: 'CAMPAIGN', entity_id: campId, target_cpa: targetCpa, strategy_mode: 'AUTO' },
            summaryTitle: `Adjust Campaign ${campId} Target CPA -> ${fmtMoney(targetCpa)}`,
            summaryLines: [`Campaign ID : ${campId}`, `Target CPA  : ${fmtMoney(targetCpa)}`]
          },
          ctx
        );
      }

      if (action === 'troas') {
        const campId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange });
        const targetRoas = Number(await input({ message: 'New Target ROAS ratio (e.g. 4.0 for 400%):' }));
        await this.mutate(
          registry,
          {
            toolName: 'adjust_target_roas',
            payload: { level: 'CAMPAIGN', entity_id: campId, target_roas: targetRoas, strategy_mode: 'AUTO' },
            summaryTitle: `Adjust Campaign ${campId} Target ROAS -> ${targetRoas}x`,
            summaryLines: [`Campaign ID  : ${campId}`, `Target ROAS  : ${targetRoas}x`]
          },
          ctx
        );
      }

      if (action === 'update_budget') {
        const budgetId = budgets.length
          ? await select({
              message: 'Select CampaignBudget to update:',
              choices: budgets.map((b) => ({
                name: `[${b.campaignBudget.id}] ${b.campaignBudget.name} (Current: ${fmtMoney(fromMicros(b.campaignBudget.amountMicros))}/d)`,
                value: String(b.campaignBudget.id)
              }))
            })
          : await input({ message: 'Budget ID:' });
        const daily = Number(await input({ message: 'New daily budget amount:' }));
        await this.mutate(
          registry,
          {
            toolName: 'create_budget_and_adjust_bidding',
            payload: { action: 'UPDATE_BUDGET', budget_id: budgetId, daily_budget: daily },
            summaryTitle: `Update Budget ${budgetId} -> ${fmtMoney(daily)}/day`,
            summaryLines: [`Budget ID : ${budgetId}`, `New Daily : ${fmtMoney(daily)}`]
          },
          ctx
        );
      }

      if (action === 'new_budget') {
        const campId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange });
        const daily = Number(await input({ message: 'New daily budget amount:' }));
        await this.mutate(
          registry,
          {
            toolName: 'create_budget_and_adjust_bidding',
            payload: { action: 'CREATE_BUDGET_AND_ASSIGN_TO_CAMPAIGN', campaign_id: campId, daily_budget: daily },
            summaryTitle: `Create ${fmtMoney(daily)}/day Budget & Assign to Campaign ${campId}`,
            summaryLines: [`Campaign ID  : ${campId}`, `Daily Budget : ${fmtMoney(daily)}`]
          },
          ctx
        );
      }

      if (action === 'switch_bidding') {
        const campId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange });
        const strat = await select({
          message: 'Target Bidding Strategy:',
          choices: ['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CLICKS', 'MANUAL_CPC'].map((v) => ({ name: v, value: v }))
        });
        await this.mutate(
          registry,
          {
            toolName: 'create_budget_and_adjust_bidding',
            payload: { action: 'UPDATE_CAMPAIGN_BIDDING', campaign_id: campId, bidding_strategy_type: strat },
            summaryTitle: `Switch Campaign ${campId} -> ${strat}`,
            summaryLines: [`Campaign ID : ${campId}`, `Strategy    : ${strat}`]
          },
          ctx
        );
      }

      if (action === 'portfolio') {
        const name = await input({ message: 'Portfolio Strategy name:' });
        const type = await select({
          message: 'Portfolio strategy type:',
          choices: ['TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE'].map((v) => ({ name: v, value: v }))
        });
        let targetCpa;
        let targetRoas;
        if (type === 'TARGET_CPA') targetCpa = Number(await input({ message: 'Target CPA:' }));
        if (type === 'TARGET_ROAS') targetRoas = Number(await input({ message: 'Target ROAS ratio:' }));
        await this.mutate(
          registry,
          {
            toolName: 'create_portfolio_bidding_strategy',
            payload: { name, type, ...(targetCpa ? { target_cpa: targetCpa } : {}), ...(targetRoas ? { target_roas: targetRoas } : {}) },
            summaryTitle: `Create Portfolio Strategy "${name}" (${type})`,
            summaryLines: [`Name : ${name}`, `Type : ${type}`]
          },
          ctx
        );
      }
    }
  }
}
