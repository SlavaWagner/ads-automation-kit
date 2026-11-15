import { select, input } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export class LocationGeoAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'location-geo',
      name: 'Location, Geo-Lookup & Proximity Targeting Agent',
      group: 'MCP_PAIRED',
      sequence: 11,
      category: 'Geo & Local Targeting',
      description:
        'Analyzes geographic performance across GEOGRAPHIC_VIEW, USER_LOCATION_VIEW, and DISTANCE_VIEW, resolves cities/regions to canonical geoTargetConstants via suggest_geo_targets, and adds positive/negative geo or radius targeting.',
      pairedTools: [
        'report_locations',
        'suggest_geo_targets',
        'create_location_targeting'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');
    const campaignId = await this.pickCampaign(registry, ctx, { allowAll: true, dateRange });

    const viewType = ctx.nonInteractive
      ? 'GEOGRAPHIC_VIEW'
      : await select({
          message: 'Location view:',
          choices: [
            { name: 'GEOGRAPHIC_VIEW (Targeted Regions & Cities)', value: 'GEOGRAPHIC_VIEW' },
            { name: 'USER_LOCATION_VIEW (Physical User Presence)', value: 'USER_LOCATION_VIEW' },
            { name: 'DISTANCE_VIEW (Store Proximity Buckets)', value: 'DISTANCE_VIEW' }
          ]
        });

    const locRes = await this.invoke(
      registry,
      'report_locations',
      { date_range: dateRange, view_type: viewType, ...(campaignId ? { campaign_id: campaignId } : {}), limit: 100 },
      ctx
    );

    const rows = (locRes.results || []).map((r) => {
      const m = r.metrics || {};
      const cost = fromMicros(m.costMicros);
      const conv = Number(m.conversions || 0);
      const label =
        r.segments?.geoTargetCity ||
        r.segments?.geoTargetRegion ||
        r.geographicView?.countryCriterionId ||
        r.userLocationView?.targetingLocation ||
        r.distanceView?.distanceBucket ||
        '-';
      return {
        campaignName: r.campaign?.name || '-',
        location: label,
        locationType: r.geographicView?.locationType || viewType,
        clicks: Number(m.clicks || 0),
        cost,
        conversions: conv,
        cpa: conv > 0 ? cost / conv : 0
      };
    });

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, viewType, locations: rows }, null, 2));
      return { dateRange, locations: rows };
    }

    this.printTable(
      ['Campaign', 'Geo / Region / Bucket', 'Type', 'Clicks', 'Spend', 'Conv', 'CPA'],
      rows.map((l) => [
        truncStr(l.campaignName, 22),
        truncStr(l.location, 30),
        l.locationType,
        fmtNum(l.clicks),
        fmtMoney(l.cost),
        fmtNum(l.conversions),
        fmtMoney(l.cpa)
      ]),
      { title: `Geographic Performance Report (${viewType}, ${dateRange})` }
    );

    this.saveArtifact({ dateRange, viewType, count: rows.length, sample: rows.slice(0, 40) }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, locations: rows };

    while (true) {
      const action = await select({
        message: 'Location Agent — choose action:',
        choices: [
          { name: '1) Lookup Canonical Geo Target IDs (suggest_geo_targets) & Add Positive/Negative Target', value: 'lookup_add' },
          { name: '2) Add Local Proximity Radius Target (km / miles)', value: 'radius' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'lookup_add') {
        const namesRaw = await input({ message: 'City / region / country names (comma-separated, e.g. "München, Hamburg"):' });
        const countryCode = await input({ message: '2-letter country filter (e.g. DE, AT, CH, US — blank for any):', default: 'DE' });
        const sugRes = await this.invoke(
          registry,
          'suggest_geo_targets',
          {
            location_names: namesRaw.split(',').map((s) => s.trim()).filter(Boolean),
            ...(countryCode.trim() ? { country_code: countryCode.trim().toUpperCase() } : {})
          },
          ctx
        );
        const suggestions = sugRes.suggestions || [];
        this.printTable(
          ['Resource Name', 'Canonical Name', 'Target Type', 'Country', 'Reach'],
          suggestions.map((s) => [
            s.geoTargetConstant?.resourceName || '-',
            truncStr(s.geoTargetConstant?.canonicalName || s.geoTargetConstant?.name || '-', 34),
            s.geoTargetConstant?.targetType || '-',
            s.geoTargetConstant?.countryCode || '-',
            fmtNum(s.reach)
          ]),
          { title: 'Geo Target Constant Matches' }
        );
        if (!suggestions.length) continue;

        const chosenRn = await select({
          message: 'Select Geo Target Constant to apply to a campaign:',
          choices: [
            ...suggestions.map((s) => ({
              name: `${s.geoTargetConstant?.canonicalName} (${s.geoTargetConstant?.resourceName})`,
              value: s.geoTargetConstant?.resourceName
            })),
            { name: 'Skip / Cancel', value: '__SKIP__' }
          ]
        });
        if (chosenRn === '__SKIP__') continue;

        const targetCampId = campaignId || (await this.pickCampaign(registry, ctx, { allowAll: false, dateRange }));
        const isNegative = await select({
          message: 'Include or Exclude this location?',
          choices: [
            { name: 'Positive Geo Target', value: false },
            { name: 'Exclude Location (Negative)', value: true }
          ]
        });

        await this.mutate(
          registry,
          {
            toolName: 'create_location_targeting',
            payload: {
              campaign_id: targetCampId,
              geo_targets: [{ geo_target_constant_id: chosenRn, is_negative: isNegative }]
            },
            summaryTitle: `${isNegative ? 'Exclude' : 'Target'} ${chosenRn} on Campaign ${targetCampId}`,
            summaryLines: [`Campaign : ${targetCampId}`, `Geo      : ${chosenRn}`, `Negative : ${isNegative}`]
          },
          ctx
        );
      }

      if (action === 'radius') {
        const targetCampId = campaignId || (await this.pickCampaign(registry, ctx, { allowAll: false, dateRange }));
        const cityName = await input({ message: 'Center City Name (e.g. Berlin):' });
        const postalCode = await input({ message: 'Postal Code (optional):', default: '' });
        const countryCode = await input({ message: '2-letter Country Code (e.g. DE):', default: 'DE' });
        const radius = Number(await input({ message: 'Radius size:', default: '25' }));
        const units = await select({
          message: 'Units:',
          choices: [
            { name: 'KILOMETERS', value: 'KILOMETERS' },
            { name: 'MILES', value: 'MILES' }
          ]
        });

        await this.mutate(
          registry,
          {
            toolName: 'create_location_targeting',
            payload: {
              campaign_id: targetCampId,
              proximity_targets: [
                {
                  radius,
                  radius_units: units,
                  city_name: cityName,
                  ...(postalCode.trim() ? { postal_code: postalCode.trim() } : {}),
                  country_code: countryCode.toUpperCase()
                }
              ]
            },
            summaryTitle: `Add ${radius} ${units} Proximity around ${cityName}`,
            summaryLines: [`Campaign : ${targetCampId}`, `Center   : ${cityName} ${postalCode} (${countryCode})`, `Radius   : ${radius} ${units}`]
          },
          ctx
        );
      }
    }
  }
}
