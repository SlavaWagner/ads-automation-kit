import { select, input } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export class AudienceAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'audience',
      name: 'Audience, Demographics & Signal Agent',
      group: 'MCP_PAIRED',
      sequence: 9,
      category: 'Audiences & Targeting',
      description:
        'Audits Campaign/Ad Group audience performance, Remarketing User Lists, and Demographics (Age/Gender/Parental/Income); discovers Google In-Market/Affinity taxonomies, creates Custom/CRM/URL Audiences, and attaches observation/targeting/exclusions.',
      pairedTools: [
        'report_audiences',
        'report_demographics',
        'search_audience_segments',
        'create_audience',
        'attach_audience_targeting'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [audRes, listsRes, demoRes] = await Promise.all([
      this.invoke(registry, 'report_audiences', { date_range: dateRange, scope: 'CAMPAIGN_AUDIENCE', limit: 100 }, ctx),
      this.invoke(registry, 'report_audiences', { scope: 'USER_LISTS', limit: 100 }, ctx).catch(() => ({ results: [] })),
      this.invoke(registry, 'report_demographics', { date_range: dateRange, dimension: 'AGE_RANGE', limit: 50 }, ctx).catch(() => ({ results: [] }))
    ]);

    const audRows = (audRes.results || []).map((r) => ({
      campaignName: r.campaign?.name || '-',
      displayName: r.campaignCriterion?.displayName || '-',
      bidModifier: r.campaignCriterion?.bidModifier ?? 1,
      clicks: Number(r.metrics?.clicks || 0),
      cost: fromMicros(r.metrics?.costMicros),
      conversions: Number(r.metrics?.conversions || 0)
    }));

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, campaignAudiences: audRows, userLists: listsRes.results || [], ageDemographics: demoRes.results || [] }, null, 2));
      return { dateRange, campaignAudiences: audRows };
    }

    this.printTable(
      ['Audience Segment', 'Campaign', 'Bid Mod', 'Clicks', 'Spend', 'Conv'],
      audRows.map((a) => [
        truncStr(a.displayName, 32),
        truncStr(a.campaignName, 22),
        a.bidModifier,
        fmtNum(a.clicks),
        fmtMoney(a.cost),
        fmtNum(a.conversions)
      ]),
      { title: `Campaign Audience Performance (${dateRange})` }
    );

    this.printTable(
      ['User List ID', 'Name', 'Type', 'Search Size', 'Display Size', 'Status'],
      (listsRes.results || []).slice(0, 15).map((r) => [
        r.userList?.id || '-',
        truncStr(r.userList?.name || '-', 30),
        r.userList?.type || '-',
        fmtNum(r.userList?.sizeForSearch),
        fmtNum(r.userList?.sizeForDisplay),
        r.userList?.membershipStatus || '-'
      ]),
      { title: 'Account User Lists (Remarketing & Customer Match)' }
    );

    this.saveArtifact({ dateRange, audiencesCount: audRows.length, userListsCount: (listsRes.results || []).length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, campaignAudiences: audRows };

    while (true) {
      const action = await select({
        message: 'Audience Agent — choose action:',
        choices: [
          { name: '1) Search Google In-Market / Affinity / Custom / Life Event Taxonomies', value: 'taxonomy' },
          { name: '2) Inspect Demographics Breakdown (Gender / Parental / Income)', value: 'demo' },
          { name: '3) Create New Audience (Custom Search Intent / CRM List / Website URL Rule)', value: 'create' },
          { name: '4) Attach Audience Observation / Exclusion to Campaign or Ad Group', value: 'attach' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'taxonomy') {
        const source = await select({
          message: 'Taxonomy source:',
          choices: ['USER_INTEREST', 'USER_LIST', 'CUSTOM_AUDIENCE', 'LIFE_EVENT', 'DETAILED_DEMOGRAPHIC'].map((v) => ({ name: v, value: v }))
        });
        const term = await input({ message: 'Filter keyword (optional):', default: '' });
        const res = await this.invoke(registry, 'search_audience_segments', { source, ...(term ? { search_term: term } : {}), limit: 40 }, ctx);
        this.printTable(
          ['ID / Resource Name', 'Name', 'Type/Detail'],
          (res.results || []).map((r) => {
            const obj = r.userInterest || r.userList || r.customAudience || r.lifeEvent || r.detailedDemographic || {};
            return [obj.resourceName || obj.id || '-', truncStr(obj.name || '-', 36), obj.taxonomyType || obj.type || '-'];
          }),
          { title: `Audience Taxonomy Search (${source})` }
        );
      }

      if (action === 'demo') {
        const dim = await select({
          message: 'Dimension:',
          choices: ['AGE_RANGE', 'GENDER', 'PARENTAL_STATUS', 'INCOME_RANGE'].map((v) => ({ name: v, value: v }))
        });
        const res = await this.invoke(registry, 'report_demographics', { date_range: dateRange, dimension: dim, limit: 50 }, ctx);
        this.printTable(
          ['Campaign', 'Ad Group', 'Segment', 'Impr', 'Clicks', 'Spend', 'Conv'],
          (res.results || []).map((r) => {
            const crit = r.adGroupCriterion || {};
            const val = crit.ageRange?.type || crit.gender?.type || crit.parentalStatus?.type || crit.incomeRange?.type || '-';
            return [
              truncStr(r.campaign?.name, 20),
              truncStr(r.adGroup?.name, 18),
              val,
              fmtNum(r.metrics?.impressions),
              fmtNum(r.metrics?.clicks),
              fmtMoney(fromMicros(r.metrics?.costMicros)),
              fmtNum(r.metrics?.conversions)
            ];
          }),
          { title: `Demographics Report: ${dim}` }
        );
      }

      if (action === 'create') {
        const mode = await select({
          message: 'Audience type:',
          choices: [
            { name: 'Custom Search/URL Audience (CUSTOM_AUDIENCE)', value: 'CUSTOM_AUDIENCE' },
            { name: 'Website URL Remarketing List (RULE_BASED_URL_LIST)', value: 'RULE_BASED_URL_LIST' },
            { name: 'CRM Customer Match Empty Container (CRM_USER_LIST)', value: 'CRM_USER_LIST' }
          ]
        });
        const name = await input({ message: 'Audience name:' });
        const payload = { mode, name };
        if (mode === 'CUSTOM_AUDIENCE') {
          const kwRaw = await input({ message: 'Comma-separated search intent keywords:' });
          payload.members = kwRaw.split(',').map((s) => s.trim()).filter(Boolean).map((value) => ({ member_type: 'KEYWORD', value }));
        } else if (mode === 'RULE_BASED_URL_LIST') {
          const urlPart = await input({ message: 'URL substring to match (e.g. "/pricing" or "/thank-you"):' });
          payload.url_rules = [{ operator: 'CONTAINS', value: urlPart }];
        }
        await this.mutate(
          registry,
          {
            toolName: 'create_audience',
            payload,
            summaryTitle: `Create ${mode}: "${name}"`,
            summaryLines: [`Name : ${name}`, `Mode : ${mode}`]
          },
          ctx
        );
      }

      if (action === 'attach') {
        const campId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange });
        const audType = await select({
          message: 'Audience criterion type:',
          choices: ['USER_LIST', 'CUSTOM_AUDIENCE', 'USER_INTEREST', 'COMBINED_AUDIENCE'].map((v) => ({ name: v, value: v }))
        });
        const audId = await input({ message: 'Audience ID or Resource Name:' });
        const isNeg = await select({
          message: 'Observation/Targeting or Negative Exclusion?',
          choices: [
            { name: 'Positive Targeting / Observation', value: false },
            { name: 'Exclude Audience (Negative)', value: true }
          ]
        });
        await this.mutate(
          registry,
          {
            toolName: 'attach_audience_targeting',
            payload: {
              target_level: 'CAMPAIGN',
              parent_id: campId,
              audience_type: audType,
              audience_id_or_resource: audId,
              is_negative: isNeg
            },
            summaryTitle: `${isNeg ? 'Exclude' : 'Attach'} ${audType} on Campaign ${campId}`,
            summaryLines: [`Campaign : ${campId}`, `Audience : ${audId} (${audType})`, `Negative : ${isNeg}`]
          },
          ctx
        );
      }
    }
  }
}
