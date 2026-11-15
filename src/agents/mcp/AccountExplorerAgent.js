import chalk from 'chalk';
import { select, input, confirm } from '@inquirer/prompts';
import { BaseCliAgent, truncStr, fmtNum } from '../BaseCliAgent.js';
import { saveConfig, getConfig } from '../../config.js';
import { normalizeCustomerId } from '../../googleAdsClient.js';

export class AccountExplorerAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'account-explorer',
      name: 'Account Explorer & GAQL Inspector Agent',
      group: 'MCP_PAIRED',
      sequence: 1,
      category: 'Core & Diagnostics',
      description:
        'Discovers accessible Google Ads accounts, inspects MCC hierarchies, reviews account settings, switches default customerId, and executes custom GAQL queries or field metadata lookups.',
      pairedTools: [
        'list_accessible_customers',
        'get_account_hierarchy',
        'get_customer_info',
        'run_gaql_query',
        'get_gaql_field_metadata'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);

    let keepGoing = true;
    while (keepGoing) {
      const action = ctx.nonInteractive
        ? 'info'
        : await select({
            message: 'Account Explorer — choose workflow:',
            choices: [
              { name: '1) Inspect Active Customer Info & Optimization Score', value: 'info' },
              { name: '2) List All Accessible Google Ads Customer IDs', value: 'accessible' },
              { name: '3) View MCC & Client Account Hierarchy', value: 'hierarchy' },
              { name: '4) Switch Active Default customerId / loginCustomerId in config.json', value: 'switch' },
              { name: '5) Run Custom GAQL SELECT Query', value: 'gaql' },
              { name: '6) Inspect GAQL Field Metadata (googleAdsFields:search)', value: 'meta' },
              { name: 'Back to Main Menu', value: 'exit' }
            ]
          });

      if (action === 'exit') break;

      if (action === 'info') {
        const res = await this.invoke(registry, 'get_customer_info', {}, ctx);
        const cust = res.results?.[0]?.customer || {};
        if (ctx.json) {
          console.log(JSON.stringify(res, null, 2));
          return res;
        }
        this.printTable(
          ['Field', 'Value'],
          [
            ['Customer ID', cust.id || res.customerId],
            ['Name', cust.descriptiveName || '-'],
            ['Currency', cust.currencyCode || '-'],
            ['Time Zone', cust.timeZone || '-'],
            ['Manager (MCC)', String(Boolean(cust.manager))],
            ['Test Account', String(Boolean(cust.testAccount))],
            ['Status', cust.status || '-'],
            ['Auto-Tagging', String(Boolean(cust.autoTaggingEnabled))],
            ['Optimization Score', cust.optimizationScore !== undefined ? `${(Number(cust.optimizationScore) * 100).toFixed(1)}%` : '-'],
            ['Conversion Tracking ID', cust.conversionTrackingSetting?.conversionTrackingId || '-']
          ],
          { title: 'Active Google Ads Customer Details' }
        );
        this.saveArtifact({ action, customer: cust }, ctx.nonInteractive);
        if (ctx.nonInteractive) return res;
      }

      if (action === 'accessible') {
        const res = await this.invoke(registry, 'list_accessible_customers', {}, ctx);
        this.printTable(
          ['#', 'Customer ID', 'Resource Name'],
          (res.customerIds || []).map((id, i) => [i + 1, id, res.resourceNames[i]]),
          { title: 'Accessible Google Ads Customers' }
        );
      }

      if (action === 'hierarchy') {
        const includeHidden = await confirm({ message: 'Include hidden client accounts?', default: false });
        const res = await this.invoke(registry, 'get_account_hierarchy', { include_hidden: includeHidden }, ctx);
        const rows = (res.results || []).map((r) => {
          const cc = r.customerClient || {};
          return [
            cc.id || '-',
            truncStr(cc.descriptiveName || '-', 34),
            cc.level ?? '-',
            cc.manager ? 'MCC' : 'Client',
            cc.currencyCode || '-',
            cc.timeZone || '-',
            cc.status || '-'
          ];
        });
        this.printTable(['ID', 'Account Name', 'Lvl', 'Type', 'Currency', 'Timezone', 'Status'], rows, {
          title: 'MCC & Client Hierarchy'
        });
      }

      if (action === 'switch') {
        const raw = getConfig();
        const newCid = normalizeCustomerId(
          await input({ message: 'Enter new default Customer ID (10 digits):', default: raw.customerId || '' })
        );
        const newLoginCid = normalizeCustomerId(
          await input({
            message: 'Enter Manager MCC loginCustomerId (optional, leave blank if direct):',
            default: raw.loginCustomerId || ''
          })
        );
        const ok = await confirm({
          message: `Update local config.json -> customerId="${newCid}", loginCustomerId="${newLoginCid}"?`,
          default: true
        });
        if (ok) {
          saveConfig({ ...raw, customerId: newCid, loginCustomerId: newLoginCid });
          ctx.customerId = newCid;
          ctx.loginCustomerId = newLoginCid;
          console.log(chalk.green(`✔ Switched active account to ${newCid}${newLoginCid ? ` (MCC ${newLoginCid})` : ''}.`));
        }
      }

      if (action === 'gaql') {
        const query = await input({
          message: 'Enter GAQL SELECT query:',
          default: 'SELECT campaign.id, campaign.name, campaign.status FROM campaign LIMIT 25'
        });
        const res = await this.invoke(registry, 'run_gaql_query', { query }, ctx);
        console.log(chalk.cyan(`\nReturned ${res.count} rows:`));
        console.log(JSON.stringify((res.results || []).slice(0, 20), null, 2));
        this.saveArtifact({ action, query, count: res.count, sample: (res.results || []).slice(0, 50) });
      }

      if (action === 'meta') {
        const pattern = await input({
          message: 'Resource or field prefix pattern (e.g. "campaign", "change_event", "metrics.search_%"):',
          default: 'change_event'
        });
        const res = await this.invoke(registry, 'get_gaql_field_metadata', { resource_or_pattern: pattern, limit: 50 }, ctx);
        const rows = (res.results || []).map((f) => [
          f.name,
          f.category,
          f.dataType,
          f.selectable ? 'Y' : 'N',
          f.filterable ? 'Y' : 'N',
          f.sortable ? 'Y' : 'N',
          fmtNum((f.selectableWith || []).length)
        ]);
        this.printTable(['Field Name', 'Category', 'Data Type', 'Sel', 'Flt', 'Sort', 'With#'], rows, {
          title: `GAQL Field Metadata: "${pattern}"`
        });
      }

      if (ctx.nonInteractive) keepGoing = false;
    }
  }
}
