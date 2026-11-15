import fs from 'fs';
import { select, input } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';

export class ConversionAttributionAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'conversion-attribution',
      name: 'Conversion Actions & Offline CRM Upload Agent',
      group: 'MCP_PAIRED',
      sequence: 14,
      category: 'Conversions & Attribution',
      description:
        'Audits Conversion Actions (primary vs secondary goals, counting mode, attribution model) and campaign conversion breakdown; creates new Conversion Actions or uploads Offline Click Conversions (GCLID/GBRAID/WBRAID).',
      pairedTools: [
        'report_conversion_actions',
        'report_campaigns',
        'create_conversion_action',
        'upload_offline_click_conversions'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const convRes = await this.invoke(
      registry,
      'report_conversion_actions',
      { date_range: dateRange, include_campaign_breakdown: true, limit: 100 },
      ctx
    );

    const actions = convRes.results || [];
    const breakdown = convRes.campaignConversionBreakdown || [];

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, conversionActions: actions, campaignBreakdown: breakdown }, null, 2));
      return { dateRange, conversionActions: actions };
    }

    this.printTable(
      ['ID', 'Conversion Action', 'Type', 'Category', 'Primary', 'Counting', 'Model'],
      actions.map((r) => {
        const ca = r.conversionAction || {};
        return [
          ca.id || '-',
          truncStr(ca.name || '-', 28),
          truncStr(ca.type || '-', 16),
          ca.category || '-',
          ca.primaryForGoal ? 'PRIMARY' : 'Secondary',
          ca.countingType || '-',
          ca.attributionModelSettings?.attributionModel || '-'
        ];
      }),
      { title: 'Account Conversion Actions & Goal Configuration' }
    );

    this.printTable(
      ['Campaign', 'Conversion Action', 'Category', 'All Conv', 'Primary Conv', 'Value'],
      breakdown.slice(0, 20).map((b) => [
        truncStr(b.campaign?.name, 22),
        truncStr(b.segments?.conversionActionName, 26),
        b.segments?.conversionActionCategory || '-',
        fmtNum(b.metrics?.allConversions),
        fmtNum(b.metrics?.conversions),
        fmtMoney(b.metrics?.conversionsValue)
      ]),
      { title: `Campaign Conversion Action Breakdown (${dateRange})` }
    );

    this.saveArtifact({ dateRange, actionsCount: actions.length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, conversionActions: actions };

    while (true) {
      const action = await select({
        message: 'Conversion & Attribution Agent — choose action:',
        choices: [
          { name: '1) Create New Conversion Action (Offline CRM / Qualified Lead / Webpage)', value: 'create' },
          { name: '2) Upload Offline Click Conversions (Interactive or JSON file)', value: 'upload' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'create') {
        const name = await input({ message: 'Conversion Action name:' });
        const type = await select({
          message: 'Source type:',
          choices: ['UPLOAD_CLICKS', 'WEBPAGE', 'UPLOAD_CALLS', 'PHONE_CALL_LEADS'].map((v) => ({ name: v, value: v }))
        });
        const category = await select({
          message: 'Goal Category:',
          choices: ['QUALIFIED_LEAD', 'CONVERTED_LEAD', 'LEAD', 'SUBMIT_LEAD_FORM', 'PURCHASE', 'BOOK_APPOINTMENT', 'REQUEST_QUOTE'].map((v) => ({ name: v, value: v }))
        });
        const defVal = Number(await input({ message: 'Default conversion value:', default: '0' }));
        const currency = await input({ message: 'Currency code (3 letters, e.g. EUR, USD):', default: 'EUR' });

        await this.mutate(
          registry,
          {
            toolName: 'create_conversion_action',
            payload: { name, type, category, default_value: defVal, default_currency_code: currency.toUpperCase() },
            summaryTitle: `Create Conversion Action "${name}"`,
            summaryLines: [`Type     : ${type}`, `Category : ${category}`, `Value    : ${defVal} ${currency.toUpperCase()}`]
          },
          ctx
        );
      }

      if (action === 'upload') {
        const actionId = actions.length
          ? await select({
              message: 'Select target Conversion Action:',
              choices: actions.map((r) => ({ name: `[${r.conversionAction.id}] ${r.conversionAction.name} (${r.conversionAction.type})`, value: String(r.conversionAction.id) }))
            })
          : await input({ message: 'Conversion Action ID:' });

        const sourceMode = await select({
          message: 'Conversion input source:',
          choices: [
            { name: 'Enter a single offline conversion manually', value: 'manual' },
            { name: 'Load batch conversions array from a local JSON file', value: 'file' }
          ]
        });

        let conversions;
        if (sourceMode === 'file') {
          const p = await input({ message: 'Path to JSON file containing conversions array:' });
          conversions = JSON.parse(fs.readFileSync(p.trim(), 'utf8'));
        } else {
          const gclid = await input({ message: 'GCLID (leave blank if GBRAID/WBRAID):', default: '' });
          const gbraid = !gclid ? await input({ message: 'GBRAID (optional):', default: '' }) : '';
          const convDt = await input({ message: 'Timestamp ("yyyy-mm-dd hh:mm:ss+|-hh:mm"):', default: '2026-11-09 12:00:00+01:00' });
          const val = Number(await input({ message: 'Conversion value:', default: '100' }));
          const cur = await input({ message: 'Currency (3-letter code):', default: 'EUR' });
          conversions = [
            {
              ...(gclid ? { gclid } : {}),
              ...(gbraid ? { gbraid } : {}),
              conversion_date_time: convDt,
              conversion_value: val,
              currency_code: cur.toUpperCase()
            }
          ];
        }

        await this.mutate(
          registry,
          {
            toolName: 'upload_offline_click_conversions',
            payload: { conversion_action_id: actionId, conversions },
            summaryTitle: `Upload ${conversions.length} Offline Click Conversion(s)`,
            summaryLines: [`Conversion Action : ${actionId}`, `Records           : ${conversions.length}`]
          },
          ctx
        );
      }
    }
  }
}
