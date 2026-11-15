import chalk from 'chalk';
import { select, input } from '@inquirer/prompts';
import { BaseCliAgent, fmtMoney, fmtNum, truncStr } from '../BaseCliAgent.js';
import { fromMicros } from '../../googleAdsClient.js';
import { syncChangeEventsToLedger, saveEventImpactAssessment, getTrackedChangeEvents } from '../../memory.js';

function addDaysIso(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Pure Before-vs-After performance attribution for a tracked Change History event.
 */
export function computeBeforeAfterImpact(eventRecord, dailyCampaignRows = []) {
  const changeDate = String(eventRecord.changeDateTime || '').slice(0, 10);
  if (!changeDate || !/^\d{4}-\d{2}-\d{2}$/.test(changeDate)) {
    return { status: 'NO_DATE', verdict: 'UNAVAILABLE' };
  }

  const campaignId = String(eventRecord.campaign || '').split('/').pop();
  const preStart = addDaysIso(changeDate, -7);
  const postEnd = addDaysIso(changeDate, 7);

  const relevant = dailyCampaignRows.filter((r) => {
    if (!campaignId) return true;
    return String(r.campaign?.id || '') === campaignId;
  });

  const pre = { days: 0, cost: 0, clicks: 0, impressions: 0, conversions: 0 };
  const post = { days: 0, cost: 0, clicks: 0, impressions: 0, conversions: 0 };

  for (const r of relevant) {
    const dt = r.segments?.date;
    if (!dt) continue;
    const m = r.metrics || {};
    const cost = fromMicros(m.costMicros);
    const clicks = Number(m.clicks || 0);
    const impressions = Number(m.impressions || 0);
    const conversions = Number(m.conversions || 0);

    if (dt >= preStart && dt < changeDate) {
      pre.days += 1;
      pre.cost += cost;
      pre.clicks += clicks;
      pre.impressions += impressions;
      pre.conversions += conversions;
    } else if (dt > changeDate && dt <= postEnd) {
      post.days += 1;
      post.cost += cost;
      post.clicks += clicks;
      post.impressions += impressions;
      post.conversions += conversions;
    }
  }

  if (post.days === 0) {
    return { changeDate, pre, post, verdict: 'TOO_RECENT' };
  }

  const preCpa = pre.conversions > 0 ? pre.cost / pre.conversions : null;
  const postCpa = post.conversions > 0 ? post.cost / post.conversions : null;
  const preConvPerDay = pre.days > 0 ? pre.conversions / pre.days : 0;
  const postConvPerDay = post.conversions / post.days;

  let verdict = 'NEUTRAL';
  if (postConvPerDay > preConvPerDay * 1.1 && (postCpa === null || preCpa === null || postCpa <= preCpa * 1.05)) {
    verdict = 'POSITIVE_LIFT';
  } else if (
    (postConvPerDay < preConvPerDay * 0.85 && preConvPerDay > 0) ||
    (postCpa !== null && preCpa !== null && postCpa > preCpa * 1.25)
  ) {
    verdict = 'NEGATIVE_REGRESSION';
  }

  return {
    changeDate,
    pre: { ...pre, convPerDay: Number(preConvPerDay.toFixed(2)), cpa: preCpa ? Number(preCpa.toFixed(2)) : null },
    post: { ...post, convPerDay: Number(postConvPerDay.toFixed(2)), cpa: postCpa ? Number(postCpa.toFixed(2)) : null },
    verdict
  };
}

export class ChangeHistoryListenerAgent extends BaseCliAgent {
  constructor() {
    super({
      id: 'change-history-listener',
      name: 'Change History & Continuous Event Listener Agent',
      group: 'MCP_PAIRED',
      sequence: 16,
      category: 'Event Listener & Episodic Memory',
      description:
        'Fetches Change History (change_event), fingerprints events into persistent Episodic Memory, correlates Pre/Post campaign performance impact (7d before vs 7d after), supports live --watch polling, and offers emergency rollback pauses.',
      pairedTools: [
        'report_change_history',
        'report_campaigns',
        'report_times',
        'update_entity_status'
      ]
    });
  }

  async syncAndEvaluate(registry, ctx = {}, daysBack = 14) {
    const chRes = await this.invoke(registry, 'report_change_history', { mode: 'CHANGE_EVENT', days_back: daysBack, limit: 200 }, ctx);
    const cid = chRes.customerId || ctx.customerId || 'default';
    const syncRes = syncChangeEventsToLedger(cid, chRes.results || []);

    const timeRes = await this.invoke(
      registry,
      'report_times',
      { date_range: 'LAST_30_DAYS', granularity: 'DATE', limit: 2000 },
      ctx
    ).catch(() => ({ results: [] }));

    const evaluated = syncRes.events.slice(0, 40).map((ev) => {
      const impact = computeBeforeAfterImpact(ev, timeRes.results || []);
      saveEventImpactAssessment(cid, ev.fingerprint, impact);
      return { ...ev, impactAssessment: impact };
    });

    return { customerId: cid, newEvents: syncRes.newEvents, totalTracked: syncRes.totalTracked, evaluated };
  }

  async run(registry, ctx = {}) {
    this.printBanner(ctx);

    if (ctx.watch) {
      const intervalSec = Math.max(15, Number(ctx.intervalSec || 60));
      console.log(chalk.cyan(`Starting Continuous Change Event Listener (polling every ${intervalSec}s, Ctrl+C to stop)...\n`));
      const initial = await this.syncAndEvaluate(registry, ctx, 7);
      console.log(chalk.green(`Initial sync complete: ${initial.totalTracked} events in Episodic Memory (${initial.newEvents.length} new).`));

      while (true) {
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
        try {
          const tick = await this.invoke(registry, 'report_change_history', { mode: 'CHANGE_EVENT', days_back: 2, limit: 100 }, ctx);
          const syncRes = syncChangeEventsToLedger(tick.customerId || ctx.customerId || 'default', tick.results || []);
          const ts = new Date().toISOString();
          if (syncRes.newEvents.length) {
            console.log(chalk.bold.yellow(`\n[${ts}] ALERT: ${syncRes.newEvents.length} NEW account change(s) detected!`));
            for (const ev of syncRes.newEvents) {
              console.log(
                chalk.white(
                  `  • ${ev.changeDateTime} | ${ev.resourceType} (${ev.operation}) by ${ev.userEmail || ev.clientType} | Fields: ${(ev.changedFields || []).join(', ')}`
                )
              );
            }
          } else {
            console.log(chalk.gray(`[${ts}] No new account changes detected.`));
          }
        } catch (err) {
          console.log(chalk.red(`[Event Listener Poll Error] ${err.message}`));
        }
      }
    }

    const res = await this.syncAndEvaluate(registry, ctx, 14);
    if (ctx.json) {
      console.log(JSON.stringify(res, null, 2));
      return res;
    }

    console.log(
      chalk.cyan(
        `Episodic Memory Synced: ${res.newEvents.length} new events added (${res.totalTracked} total tracked for account ${res.customerId}).\n`
      )
    );

    this.printTable(
      ['Date/Time', 'Resource Type', 'Op', 'Actor / Client', 'Pre->Post Conv/d', 'Verdict'],
      res.evaluated.slice(0, 25).map((ev) => {
        const imp = ev.impactAssessment || {};
        const deltaStr =
          imp.pre?.convPerDay !== undefined && imp.post?.convPerDay !== undefined
            ? `${imp.pre.convPerDay} -> ${imp.post.convPerDay}`
            : 'pending';
        return [
          truncStr(ev.changeDateTime, 19),
          ev.resourceType || '-',
          ev.operation || '-',
          truncStr(ev.userEmail || ev.clientType || '-', 22),
          deltaStr,
          imp.verdict || '-'
        ];
      }),
      { title: 'Change History Ledger & Before/After Impact Correlation' }
    );

    this.saveArtifact({ customerId: res.customerId, totalTracked: res.totalTracked, recentEvaluated: res.evaluated.slice(0, 25) }, ctx.nonInteractive);
    if (ctx.nonInteractive) return res;

    while (true) {
      const action = await select({
        message: 'Change History Event Listener — choose action:',
        choices: [
          { name: '1) Start Continuous Live Watch Mode (Event Listener Loop)', value: 'watch' },
          { name: '2) Inspect Negative-Regression Changes & Pause Modified Entity', value: 'rollback' },
          { name: '3) View Full Stored Episodic Memory Change Ledger', value: 'ledger' },
          { name: '4) Run AI Root-Cause Assessment on Recent Regressions', value: 'ai' },
          { name: 'Back to Main Menu', value: 'exit' }
        ]
      });

      if (action === 'exit') break;

      if (action === 'watch') {
        const sec = Number(await input({ message: 'Polling interval in seconds (min 15):', default: '60' }));
        ctx.watch = true;
        ctx.intervalSec = sec;
        return await this.run(registry, ctx);
      }

      if (action === 'ledger') {
        const stored = getTrackedChangeEvents(res.customerId);
        this.printTable(
          ['First Seen', 'Change Time', 'Type', 'Op', 'Changed Fields'],
          stored.slice(0, 30).map((s) => [
            truncStr(s.firstSeenAt, 19),
            truncStr(s.changeDateTime, 19),
            s.resourceType || '-',
            s.operation || '-',
            truncStr((s.changedFields || []).join(','), 36)
          ]),
          { title: `Episodic Memory Ledger (${stored.length} stored events)` }
        );
      }

      if (action === 'rollback') {
        const regressed = res.evaluated.filter((e) => e.campaign || e.adGroup);
        if (!regressed.length) {
          console.log(chalk.yellow('No campaign/adGroup change events available to mitigate.'));
          continue;
        }
        const picked = await select({
          message: 'Select modified entity to PAUSE as risk mitigation:',
          choices: regressed.slice(0, 20).map((e) => ({
            name: `${e.changeDateTime} | ${e.resourceType} | Verdict: ${e.impactAssessment?.verdict} | ${e.resourceName}`,
            value: e
          }))
        });
        const entityType = picked.adGroup ? 'AD_GROUP' : 'CAMPAIGN';
        const rn = picked.adGroup || picked.campaign;
        await this.mutate(
          registry,
          {
            toolName: 'update_entity_status',
            payload: { entity_type: entityType, status: 'PAUSED', resource_names_or_ids: [rn] },
            summaryTitle: `Emergency Pause ${entityType} (${picked.impactAssessment?.verdict || 'MANUAL'})`,
            summaryLines: [`Resource     : ${rn}`, `Triggered By : Change Event ${picked.changeDateTime}`]
          },
          ctx
        );
      }

      if (action === 'ai') {
        await this.offerAiAnalysis(
          res.evaluated.slice(0, 20),
          'Correlate recent Google Ads Change History events with before/after conversion and CPA shifts.'
        );
      }
    }
  }
}
