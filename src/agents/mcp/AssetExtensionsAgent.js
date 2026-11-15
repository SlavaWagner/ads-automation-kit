import { select, input } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';

export class AssetExtensionsAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'asset-extensions',
      name: 'Assets, Extensions & Labels Agent',
      group: 'MCP_PAIRED',
      sequence: 8,
      category: 'Assets & Extensions',
      description:
        'Inventories Account Assets, Campaign Sitelinks/Callouts/Images, and RSA Asset performance labels; creates/uploads new reusable Assets (Text, Image File, Sitelink, Callout, Snippet, Call, Video), links them to Account/Campaign/Ad Group/Asset Group, and manages Labels.',
      pairedTools: [
        'report_assets',
        'report_landing_pages',
        'create_and_upload_asset',
        'link_assets',
        'manage_labels'
      ]
    });
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);
    const dateRange = await this.pickDateRange(ctx, 'LAST_30_DAYS');

    const [catalogRes, campAssetsRes] = await Promise.all([
      this.invoke(registry, 'report_assets', { view: 'ASSET_CATALOG', limit: 150 }, ctx),
      this.invoke(registry, 'report_assets', { view: 'CAMPAIGN_ASSETS', date_range: dateRange, limit: 150 }, ctx).catch(() => ({ results: [] }))
    ]);

    if (ctx.json) {
      console.log(JSON.stringify({ dateRange, catalog: catalogRes.results || [], campaignAssets: campAssetsRes.results || [] }, null, 2));
      return { dateRange, catalog: catalogRes.results || [] };
    }

    this.printTable(
      ['Asset ID', 'Type', 'Name / Text Preview', 'Resource Name'],
      (catalogRes.results || []).slice(0, 25).map((r) => {
        const a = r.asset || {};
        const preview =
          a.textAsset?.text || a.sitelinkAsset?.linkText || a.calloutAsset?.calloutText || a.name || a.youtubeVideoAsset?.youtubeVideoId || '-';
        return [a.id || '-', a.type || '-', truncStr(preview, 32), truncStr(a.resourceName || '-', 34)];
      }),
      { title: 'Reusable Assets Catalog' }
    );

    this.printTable(
      ['Campaign', 'Field Type', 'Status', 'Preview', 'Impr', 'Clicks', 'Spend'],
      (campAssetsRes.results || []).slice(0, 20).map((r) => [
        truncStr(r.campaign?.name, 22),
        r.campaignAsset?.fieldType || '-',
        r.campaignAsset?.status || '-',
        truncStr(r.asset?.sitelinkAsset?.linkText || r.asset?.calloutAsset?.calloutText || r.asset?.textAsset?.text || '-', 24),
        fmtNum(r.metrics?.impressions),
        fmtNum(r.metrics?.clicks),
        fmtMoney(fromMicros(r.metrics?.costMicros))
      ]),
      { title: `Campaign Extension Assets Performance (${dateRange})` }
    );

    this.saveArtifact({ catalogCount: (catalogRes.results || []).length, campaignAssetsCount: (campAssetsRes.results || []).length }, ctx.nonInteractive);
    if (ctx.nonInteractive) return { dateRange, catalog: catalogRes.results || [] };

    while (true) {
      const action = await select({
        message: 'Assets & Extensions Agent — choose action:',
        choices: [
          { name: '1) Create / Upload New Asset (Callout, Sitelink, Structured Snippet, Text, Image, Video)', value: 'create_asset' },
          { name: '2) Link Existing Asset to Campaign / Customer / Ad Group / Asset Group', value: 'link' },
          { name: '3) Create or Attach Account Labels (manage_labels)', value: 'labels' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'create_asset') {
        const aType = await select({
          message: 'Asset type:',
          choices: [
            { name: 'CALLOUT (<= 25 chars)', value: 'CALLOUT' },
            { name: 'SITELINK', value: 'SITELINK' },
            { name: 'STRUCTURED_SNIPPET', value: 'STRUCTURED_SNIPPET' },
            { name: 'TEXT', value: 'TEXT' },
            { name: 'IMAGE_FILE (from local path)', value: 'IMAGE_FILE' },
            { name: 'YOUTUBE_VIDEO (by video ID)', value: 'YOUTUBE_VIDEO' }
          ]
        });

        const payload = { asset_type: aType };
        if (aType === 'CALLOUT') {
          payload.callout_text = await input({ message: 'Callout text (max 25 chars):' });
        } else if (aType === 'SITELINK') {
          const linkText = await input({ message: 'Sitelink link text (max 25 chars):' });
          const desc1 = await input({ message: 'Description 1 (max 35 chars, optional):', default: '' });
          const url = await input({ message: 'Final URL (https://...):' });
          payload.final_urls = [url];
          payload.sitelink = { link_text: linkText, ...(desc1 ? { description1: desc1 } : {}) };
        } else if (aType === 'STRUCTURED_SNIPPET') {
          const header = await input({ message: 'Snippet header (e.g. Services, Types, Brands):', default: 'Services' });
          const vals = await input({ message: '3-10 snippet values (comma-separated):' });
          payload.structured_snippet = { header, values: vals.split(',').map((s) => s.trim()).filter(Boolean) };
        } else if (aType === 'TEXT') {
          payload.text = await input({ message: 'Asset text:' });
        } else if (aType === 'IMAGE_FILE') {
          payload.name = await input({ message: 'Asset name:' });
          payload.image_file_path = await input({ message: 'Local image file path:' });
        } else if (aType === 'YOUTUBE_VIDEO') {
          payload.youtube_video_id = await input({ message: 'YouTube Video ID (11 chars):' });
        }

        await this.mutate(
          registry,
          {
            toolName: 'create_and_upload_asset',
            payload,
            summaryTitle: `Create ${aType} Asset`,
            summaryLines: [JSON.stringify(payload)]
          },
          ctx
        );
      }

      if (action === 'link') {
        const scope = await select({
          message: 'Link Scope:',
          choices: ['CAMPAIGN', 'CUSTOMER', 'AD_GROUP', 'ASSET_GROUP'].map((v) => ({ name: v, value: v }))
        });
        let parentId;
        if (scope === 'CAMPAIGN') parentId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange });
        else if (scope === 'AD_GROUP') parentId = await this.pickAdGroup(registry, ctx, { allowAll: false, dateRange });
        else if (scope === 'ASSET_GROUP') parentId = await input({ message: 'Asset Group ID:' });

        const assetRn = await input({ message: 'Asset Resource Name or ID:' });
        const fieldType = await input({ message: 'Field Type (e.g. CALLOUT, SITELINK, STRUCTURED_SNIPPET, HEADLINE, MARKETING_IMAGE):' });

        await this.mutate(
          registry,
          {
            toolName: 'link_assets',
            payload: {
              operation: 'CREATE_LINK',
              scope,
              ...(parentId ? { parent_id: parentId } : {}),
              links: [{ asset_resource_name: assetRn, field_type: fieldType.toUpperCase() }]
            },
            summaryTitle: `Link Asset (${fieldType}) -> ${scope}`,
            summaryLines: [`Asset : ${assetRn}`, `Parent: ${parentId || 'CUSTOMER'}`]
          },
          ctx
        );
      }

      if (action === 'labels') {
        const labelAction = await select({
          message: 'Label action:',
          choices: [
            { name: 'CREATE_LABEL', value: 'CREATE_LABEL' },
            { name: 'ATTACH_LABEL to Campaigns', value: 'ATTACH_LABEL' }
          ]
        });
        if (labelAction === 'CREATE_LABEL') {
          const name = await input({ message: 'Label name:' });
          const color = await input({ message: 'Hex color (e.g. #0086F4):', default: '#0086F4' });
          await this.mutate(
            registry,
            {
              toolName: 'manage_labels',
              payload: { action: 'CREATE_LABEL', name, background_color: color },
              summaryTitle: `Create Label "${name}"`,
              summaryLines: [`Name : ${name}`, `Color: ${color}`]
            },
            ctx
          );
        } else {
          const labelId = await input({ message: 'Existing Label ID:' });
          const campId = await this.pickCampaign(registry, ctx, { allowAll: false, dateRange });
          await this.mutate(
            registry,
            {
              toolName: 'manage_labels',
              payload: { action: 'ATTACH_LABEL', target_type: 'CAMPAIGN', label_id: labelId, target_resource_names_or_ids: [campId] },
              summaryTitle: `Attach Label ${labelId} -> Campaign ${campId}`,
              summaryLines: [`Label    : ${labelId}`, `Campaign : ${campId}`]
            },
            ctx
          );
        }
      }
    }
  }
}
