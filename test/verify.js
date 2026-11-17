import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Create isolated temporary config & storage dirs so user's workspace remains untouched
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-kit-test-'));
const TMP_CFG = path.join(TMP_DIR, 'config.json');
const TMP_STORAGE = path.join(TMP_DIR, 'storage');
process.env.ADS_KIT_CONFIG = TMP_CFG;
process.env.ADS_KIT_STORAGE_DIR = TMP_STORAGE;

import { isRunningInsideAntigravity } from '../src/guard.js';
import { getConfig, saveConfig } from '../src/config.js';
import { createToolRegistry } from '../src/mcp/toolRegistry.js';
import { createAgentRegistry } from '../src/agents/agentRegistry.js';
import { sanitizeAdCopy, executeWithConfirmation } from '../src/safety.js';
import {
  syncChangeEventsToLedger,
  saveEventImpactAssessment,
  getTrackedChangeEvents,
  getDecisions,
  saveAngleKnowledgeEntry,
  getAngleKnowledgeBase
} from '../src/memory.js';

import { diagnoseCampaigns } from '../src/agents/mcp/CampaignAgent.js';
import { scoreAndFilterKeywordIdeas } from '../src/agents/mcp/KeywordAgent.js';
import { analyzeSearchTermsNGrams } from '../src/agents/mcp/SearchTermAgent.js';
import { computeBeforeAfterImpact } from '../src/agents/mcp/ChangeHistoryListenerAgent.js';
import { detectPlacementWaste } from '../src/agents/mcp/PlacementAgent.js';
import { rankDaypartWindows } from '../src/agents/mcp/DaypartingScheduleAgent.js';

import { mineIntentAngleClusters } from '../src/agents/rd/AngleDiscoveryAgent.js';
import { buildDeterministicRsaDraft } from '../src/agents/rd/AiAssetGeneratorAgent.js';
import { evaluateAssetTests } from '../src/agents/rd/AssetTestingAgent.js';
import { jaccardSimilarity, analyzeCreativePortfolioHealth } from '../src/agents/rd/AssetIntelligenceAgent.js';
import { planMicroStepScaling } from '../src/agents/rd/BudgetScalingAgent.js';
import { analyzeSearchIntentSignals } from '../src/agents/rd/SearchTermIntelAgent.js';
import { detectZScoreAnomalies } from '../src/agents/rd/AnomalyHealthAgent.js';
import { analyzeCrossFormatYield } from '../src/agents/rd/FormatPlacementAgent.js';
import { forecastTimeSeries, estimateCreativeFatigue } from '../src/agents/rd/PredictiveForecastAgent.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✔ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✖ FAIL: ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✖ FAIL: ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

console.log('\n=== ads-automation-kit Automated Verification Suite ===\n');

// 1. Antigravity Guard checks
test('1. Guard allows execution with --inside-agy or AGY_SESSION=1 and blocks bare shells', () => {
  assert.strictEqual(isRunningInsideAntigravity(['node', 'cli.js'], {}), false);
  assert.strictEqual(isRunningInsideAntigravity(['node', 'cli.js', '--inside-agy'], {}), true);
  assert.strictEqual(isRunningInsideAntigravity(['node', 'cli.js'], { AGY_SESSION: '1' }), true);
  assert.strictEqual(isRunningInsideAntigravity(['node', 'cli.js'], { ANTIGRAVITY_PROJECT_ID: 'abc' }), true);

  // Spawn bare process without Antigravity env
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (k.startsWith('ANTIGRAVITY_') || k.startsWith('AGY_') || k === 'AGY') {
      delete cleanEnv[k];
    }
  }
  const bareRun = spawnSync('node', [path.join(ROOT, 'bin', 'cli.js'), 'tools'], {
    env: cleanEnv,
    encoding: 'utf8'
  });
  assert.strictEqual(bareRun.status, 0);
  assert.match(bareRun.stdout, /PREREQUISITE REQUIRED: GOOGLE ANTIGRAVITY CLI/);
});

// 2. Config & Env compatibility with ai-ads-pipeline
test('2. Config round-trip & ai-ads-pipeline schema compatibility', () => {
  const ok = saveConfig({
    customerId: '1234567890',
    developerToken: 'DEV_TOK',
    clientId: 'CLIENT_ID',
    clientSecret: 'CLIENT_SECRET',
    refreshToken: 'REF_TOK',
    googleAdsVersion: 'v24',
    loginCustomerId: '9999999999',
    geminiApiKey: 'antigravity'
  });
  assert.strictEqual(ok, true);
  const cfg = getConfig();
  assert.strictEqual(cfg.customerId, '1234567890');
  assert.strictEqual(cfg.googleAdsVersion, 'v24');
  assert.strictEqual(cfg.geminiApiKey, 'antigravity');
});

// 3. ToolRegistry & Exact 56-Tool Completeness
const toolRegistry = createToolRegistry();
test('3. ToolRegistry registers all 56 Google Ads MCP tools cleanly (5 Core, 5 Research, 22 Report, 24 Mutate)', () => {
  const all = toolRegistry.list();
  assert.strictEqual(all.length, 56, `Expected 56 tools, got ${all.length}`);
  assert.strictEqual(toolRegistry.list('CORE').length, 5);
  assert.strictEqual(toolRegistry.list('RESEARCH').length, 5);
  assert.strictEqual(toolRegistry.list('REPORT').length, 22);
  assert.strictEqual(toolRegistry.list('MUTATE').length, 24);
});

// 4. AgentRegistry Completeness, Contiguous Sequences & 100% Tool Pairing Coverage
const agentRegistry = createAgentRegistry();
test('4. AgentRegistry loads all 25 CLI Agents (16 MCP Paired + 9 R&D Stages) in contiguous sequence with 100% tool pairing', () => {
  const mcpAgents = agentRegistry.list('MCP_PAIRED');
  const rdAgents = agentRegistry.list('RD_INTELLIGENCE');
  assert.strictEqual(mcpAgents.length, 16, `Expected 16 MCP agents, got ${mcpAgents.length}`);
  assert.strictEqual(rdAgents.length, 9, `Expected 9 R&D agents, got ${rdAgents.length}`);

  mcpAgents.forEach((agent, idx) => {
    assert.strictEqual(agent.sequence, idx + 1, `MCP agent ${agent.id} sequence mismatch: expected ${idx + 1}, got ${agent.sequence}`);
    assert.strictEqual(agent.sourceSkillFolder, undefined, `Legacy sourceSkillFolder present on ${agent.id}`);
  });
  rdAgents.forEach((agent, idx) => {
    assert.strictEqual(agent.sequence, idx + 1, `R&D agent ${agent.id} sequence mismatch: expected ${idx + 1}, got ${agent.sequence}`);
    assert.strictEqual(agent.sourceSkillFolder, undefined, `Legacy sourceSkillFolder present on ${agent.id}`);
    assert.ok(agent.category.startsWith(`R&D Stage ${idx + 1} `), `Expected aligned R&D Stage ${idx + 1} category on ${agent.id}, got "${agent.category}"`);
  });

  const coveredByMcpAgents = new Set();
  for (const agent of [...mcpAgents, ...rdAgents]) {
    assert.ok(agent.pairedTools.length >= 2, `Agent ${agent.id} should pair at least 2 tools`);
    for (const toolName of agent.pairedTools) {
      assert.strictEqual(toolRegistry.has(toolName), true, `Agent ${agent.id} references unknown tool "${toolName}"`);
      if (agent.group === 'MCP_PAIRED') coveredByMcpAgents.add(toolName);
    }
  }

  const allToolNames = toolRegistry.list().map((t) => t.name);
  const missing = allToolNames.filter((t) => !coveredByMcpAgents.has(t));
  assert.deepStrictEqual(missing, [], `Unpaired MCP tools found: ${missing.join(', ')}`);
});

// 5. Ad Copy Compliance Sanitizer & Deterministic RSA Generator
test('5. sanitizeAdCopy & buildDeterministicRsaDraft enforce 30/90-char limits and remove restricted buzzwords/punctuation', () => {
  const cleaned = sanitizeAdCopy({
    headlines: ['Boost Your ROI Immediately!', 'Short Headline.', 'A Very Long Google Ads Headline Exceeding Thirty Chars'],
    descriptions: ['Guaranteed results! Get 100% free audit now! Start scaling your conversions immediately.']
  });
  cleaned.headlines.forEach((h) => {
    assert.ok(h.length <= 30, `Headline too long: ${h}`);
    assert.ok(!/[!.]$/.test(h), `Headline has forbidden punctuation: ${h}`);
    assert.ok(!/\b(ROI|Boost|Guaranteed)\b/i.test(h), `Forbidden buzzword remained: ${h}`);
  });
  cleaned.descriptions.forEach((d) => {
    assert.ok(d.length <= 90, `Description too long: ${d}`);
    assert.ok(!/[!.]$/.test(d), `Description has forbidden punctuation: ${d}`);
  });

  const draft = buildDeterministicRsaDraft({ brandOrTopic: 'SWA Analytics', angleName: 'Verified Transparency' });
  assert.ok(draft.headlines.length >= 3);
  assert.ok(draft.descriptions.length >= 2);
});

// 6. Keyword Planner Deduplication & Opportunity Scorer
test('6. scoreAndFilterKeywordIdeas deduplicates active keywords & ranks net-new Planner ideas', () => {
  const existing = [{ adGroupCriterion: { keyword: { text: 'google ads agency' } } }];
  const ideas = [
    { text: 'google ads agency', metrics: { avgMonthlySearches: 5000, competitionIndex: 40 } },
    { text: 'b2b google ads audit', metrics: { avgMonthlySearches: 1200, competitionIndex: 35, lowTopOfPageBid: 2.1, highTopOfPageBid: 4.9 } },
    { text: 'tiny volume term', metrics: { avgMonthlySearches: 10, competitionIndex: 10 } }
  ];
  const scored = scoreAndFilterKeywordIdeas(existing, ideas, { minVolume: 50 });
  assert.strictEqual(scored.length, 1);
  assert.strictEqual(scored[0].text, 'b2b google ads audit');
  assert.strictEqual(scored[0].suggestedBid, 3.5);
});

// 7. Search Term N-Gram Waste & Winner Miner + Search Intent Intel
test('7. analyzeSearchTermsNGrams & analyzeSearchIntentSignals identify N-gram waste & converting NONE queries', () => {
  const rows = [
    { campaign: { id: '1', name: 'Search DE' }, adGroup: { id: '10' }, searchTermView: { searchTerm: 'google ads template free', status: 'NONE' }, metrics: { impressions: 200, clicks: 15, costMicros: '25000000', conversions: 0 } },
    { campaign: { id: '1', name: 'Search DE' }, adGroup: { id: '10' }, searchTermView: { searchTerm: 'crm software free download', status: 'NONE' }, metrics: { impressions: 150, clicks: 12, costMicros: '18000000', conversions: 0 } },
    { campaign: { id: '1', name: 'Search DE' }, adGroup: { id: '10' }, searchTermView: { searchTerm: 'enterprise google ads beratung', status: 'NONE' }, metrics: { impressions: 90, clicks: 8, costMicros: '22000000', conversions: 2 } }
  ];
  const ngram = analyzeSearchTermsNGrams(rows);
  assert.ok(ngram.wastedNGrams.some((n) => n.ngram === 'free' && n.cost === 43));
  assert.strictEqual(ngram.convertingAdditions[0].searchTerm, 'enterprise google ads beratung');

  const intel = analyzeSearchIntentSignals(rows, []);
  assert.strictEqual(intel.excludeCandidates.length, 2);
  assert.strictEqual(intel.promoteCandidates.length, 1);
});

// 8. Change History Episodic Memory Ledger & Before/After Impact Attribution
test('8. Change History Ledger syncs fingerprints and computes Pre vs Post conversion impact', () => {
  const events = [
    {
      changeEvent: {
        changeDateTime: '2026-10-15 10:00:00',
        changeResourceType: 'CAMPAIGN_BUDGET',
        resourceChangeOperation: 'UPDATE',
        changeResourceName: 'customers/123/campaignBudgets/1',
        campaign: 'customers/123/campaigns/99',
        userEmail: 'owner@example.com',
        changedFields: ['amount_micros']
      }
    }
  ];
  const syncRes = syncChangeEventsToLedger('123', events);
  assert.strictEqual(syncRes.newEvents.length, 1);
  // Second sync is idempotent
  const syncRes2 = syncChangeEventsToLedger('123', events);
  assert.strictEqual(syncRes2.newEvents.length, 0);
  assert.strictEqual(getTrackedChangeEvents('123').length, 1);

  const dailyRows = [
    { campaign: { id: '99' }, segments: { date: '2026-10-12' }, metrics: { costMicros: '50000000', conversions: 2 } },
    { campaign: { id: '99' }, segments: { date: '2026-10-13' }, metrics: { costMicros: '50000000', conversions: 2 } },
    { campaign: { id: '99' }, segments: { date: '2026-10-17' }, metrics: { costMicros: '50000000', conversions: 4 } },
    { campaign: { id: '99' }, segments: { date: '2026-10-18' }, metrics: { costMicros: '50000000', conversions: 4 } }
  ];
  const impact = computeBeforeAfterImpact(syncRes.events[0], dailyRows);
  assert.strictEqual(impact.verdict, 'POSITIVE_LIFT');
  saveEventImpactAssessment('123', syncRes.events[0].fingerprint, impact);
  assert.strictEqual(getTrackedChangeEvents('123')[0].impactAssessment.verdict, 'POSITIVE_LIFT');
});

// 9. R&D Creative, Budget Scaling, Z-Score Anomaly, Cross-Format, & Holt-Winters Forecast
test('9. R&D Quantitative Algorithms (Creative Health, Micro-Step Scaling, Z-Score Anomaly, Format Yield, Holt-Winters Forecast)', () => {
  // Creative health & Jaccard
  assert.ok(jaccardSimilarity('Best Cloud ERP Tool', 'Best Cloud ERP Tools') >= 0.6);
  const portfolio = analyzeCreativePortfolioHealth(
    [
      { adGroup: { id: '1', name: 'AG1' }, adGroupAd: { ad: { id: '101', responsiveSearchAd: { headlines: [{ text: 'Fast B2B Audit Solution' }, { text: 'Fast B2B Audit Solutions' }] } }, adStrength: 'GOOD', policySummary: { approvalStatus: 'APPROVED' } }, metrics: { impressions: 2000, clicks: 150, ctr: 0.075, costMicros: '80000000', conversions: 0 } },
      { adGroup: { id: '1', name: 'AG1' }, adGroupAd: { ad: { id: '102' }, adStrength: 'EXCELLENT', policySummary: { approvalStatus: 'APPROVED' } }, metrics: { impressions: 400, clicks: 40, ctr: 0.04, costMicros: '20000000', conversions: 3 } }
    ],
    [{ adGroupAdAssetView: { performanceLabel: 'BEST' } }]
  );
  assert.strictEqual(portfolio.classifiedAds[0].quadrant, 'CLICKBAIT_TRAP');
  assert.strictEqual(portfolio.classifiedAds[1].quadrant, 'HIDDEN_GEM');

  // Micro-step scaling
  const scale = planMicroStepScaling(
    [{ campaign: { id: '7', name: 'Scale Winner', status: 'ENABLED', campaignBudget: 'customers/1/campaignBudgets/55' }, campaignBudget: { amountMicros: '100000000' }, metrics: { costMicros: '900000000', conversions: 30, conversionsValue: 4500 } }],
    [{ campaign: { id: '7' }, metrics: { searchBudgetLostImpressionShare: 0.35 } }],
    []
  );
  assert.strictEqual(scale[0].action, 'SCALE_UP_15PCT');
  assert.strictEqual(scale[0].proposedBudget, 115);

  // Z-Score Anomaly Detection
  const normalDays = Array.from({ length: 10 }, (_, i) => ({
    campaign: { id: '8', name: 'Search Core' },
    segments: { date: `2026-10-${String(i + 1).padStart(2, '0')}` },
    metrics: { costMicros: String((50 + (i % 2) * 2) * 1_000_000), conversions: 3 }
  }));
  normalDays.push({
    campaign: { id: '8', name: 'Search Core' },
    segments: { date: '2026-10-11' },
    metrics: { costMicros: '250000000', conversions: 0 }
  });
  const anomalies = detectZScoreAnomalies(normalDays);
  assert.ok(anomalies.some((a) => a.metric === 'SPEND' && a.direction === 'SPIKE'));
  assert.ok(anomalies.some((a) => a.metric === 'CONVERSIONS_OUTAGE'));

  // Holt-Winters Forecast & Fatigue
  const fc = forecastTimeSeries(normalDays.slice(0, 10), 7);
  assert.strictEqual(fc.status, 'OK');
  assert.strictEqual(fc.forecast.length, 7);
  const fatigue = estimateCreativeFatigue(normalDays.map((d, idx) => ({ ...d, metrics: { impressions: 1000, clicks: idx < 5 ? 60 : 30 } })));
  assert.strictEqual(fatigue.status, 'FATIGUE_DETECTED');

  // Misc domain helpers
  assert.strictEqual(diagnoseCampaigns([{ campaign: { id: '1', name: 'C', status: 'ENABLED' }, metrics: { conversions: 5, costMicros: '50000000' } }], [{ campaign: { id: '1' }, metrics: { searchBudgetLostImpressionShare: 0.3 } }])[0].flags[0], 'BUDGET_THROTTLED_WINNER');
  assert.strictEqual(detectPlacementWaste([{ detailPlacementView: { placement: 'adsenseformobileapps.com', placementType: 'MOBILE_APPLICATION' }, metrics: { costMicros: '20000000', conversions: 0, clicks: 15 } }]).length, 1);
  assert.strictEqual(rankDaypartWindows([{ segments: { dayOfWeek: 'MONDAY' }, metrics: { clicks: 20, costMicros: '10000000', conversions: 2 } }])[0].window, 'MONDAY');
  assert.strictEqual(analyzeCrossFormatYield([{ campaign: { advertisingChannelType: 'SEARCH' }, metrics: { costMicros: '10000000', conversions: 1 } }]).channels[0].channel, 'SEARCH');
  assert.strictEqual(mineIntentAngleClusters([{ searchTermView: { searchTerm: 'vs competitor review' }, metrics: { clicks: 5, conversions: 1, costMicros: '5000000' } }], []).buckets.OBJECTION_COMPARISON.length, 1);
  assert.strictEqual(evaluateAssetTests([], [{ adGroupAdAssetView: { fieldType: 'HEADLINE', performanceLabel: 'LOW' }, asset: { textAsset: { text: 'Weak' } }, metrics: { impressions: 1500, clicks: 5, conversions: 0 } }]).assetKillCandidates.length, 1);
});

// 10. Safety Dry-Run + Episodic Memory Decision Receipt Integration
await asyncTest('10. executeWithConfirmation (dryRunOnly=true) invokes registry & logs Decision Receipt', async () => {
  const mockCalls = [];
  const fakeRegistry = {
    async invoke(toolName, args) {
      mockCalls.push({ toolName, args });
      return { customerId: '1234567890', results: [{ resourceName: 'customers/1234567890/adGroupCriteria/1~2' }], validateOnly: args.validate_only };
    }
  };
  const outcome = await executeWithConfirmation({
    registry: fakeRegistry,
    agentId: 'keyword',
    toolName: 'create_keywords',
    payload: { ad_group_id: '1', keywords: [{ text: 'test kw', match_type: 'EXACT' }] },
    summaryTitle: 'Dry-run upload 1 keyword',
    dryRunOnly: true
  });
  assert.strictEqual(outcome.status, 'DRY_RUN_OK');
  assert.strictEqual(mockCalls[0].args.validate_only, true);
  assert.strictEqual(getDecisions(10).length, 1);
  assert.strictEqual(getDecisions(10)[0].dryRun, true);
  saveAngleKnowledgeEntry('1234567890', { angles: [{ name: 'Test Angle' }] });
  assert.strictEqual(getAngleKnowledgeBase('1234567890').length, 1);
});

// 11. End-to-End Agent Execution via Mock Registry (Keyword + ChangeHistoryListener)
await asyncTest('11. End-to-End non-interactive execution of KeywordAgent & ChangeHistoryListenerAgent against mock ToolRegistry', async () => {
  const mockRegistry = {
    async invoke(name) {
      if (name === 'report_campaigns') return { results: [] };
      if (name === 'report_keywords') return { customerId: '123', results: [{ adGroup: { id: '5', name: 'Core' }, adGroupCriterion: { criterionId: '9', status: 'ENABLED', keyword: { text: 'audit software', matchType: 'EXACT' }, qualityInfo: { qualityScore: 8 } }, metrics: { clicks: 20, ctr: 0.05, costMicros: '20000000', conversions: 2 } }] };
      if (name === 'report_impression_share') return { results: [] };
      if (name === 'report_change_history') return { customerId: '123', results: [{ changeEvent: { changeDateTime: '2026-10-20 09:00:00', changeResourceType: 'CAMPAIGN', resourceChangeOperation: 'UPDATE', campaign: 'customers/123/campaigns/1', userEmail: 'ops@test.com', changedFields: ['status'] } }] };
      if (name === 'report_times') return { results: [] };
      return { results: [] };
    }
  };

  const kwOut = await agentRegistry.get('keyword').run(mockRegistry, { customerId: '123', dateRange: 'LAST_30_DAYS', nonInteractive: true });
  assert.strictEqual(kwOut.keywords.length, 1);
  const chOut = await agentRegistry.get('change-history-listener').run(mockRegistry, { customerId: '123', nonInteractive: true });
  assert.strictEqual(chOut.totalTracked, 2); // 1 from test 8 + 1 new here
});

// 12. Exhaustive Non-Interactive Smoke Run across ALL 25 CLI Agents
await asyncTest('12. All 25 CLI Agents (16 MCP + 9 R&D) execute non-interactive run() cleanly without ReferenceError/TypeError', async () => {
  const universalMockRegistry = {
    async invoke(name) {
      if (name === 'get_customer_info') return { customerId: '123', results: [{ customer: { id: '123', descriptiveName: 'Mock Co', currencyCode: 'EUR' } }] };
      if (name === 'report_budgets_and_bidding') return { customerId: '123', campaignBudgets: [], portfolioBiddingStrategies: [] };
      if (name === 'report_policy_diagnostics') return { customerId: '123', disapprovedOrLimitedAds: [], assetGroupStatuses: [] };
      if (name === 'report_conversion_actions') return { customerId: '123', results: [], campaignConversionBreakdown: [] };
      if (name === 'report_shopping_and_pmax_insights') return { customerId: '123', results: [] };
      return { customerId: '123', results: [] };
    }
  };
  for (const agent of agentRegistry.list()) {
    await agent.run(universalMockRegistry, {
      customerId: '123',
      dateRange: 'LAST_30_DAYS',
      nonInteractive: true,
      json: true
    });
  }
});

// 13. Real Stdio MCP Server JSON-RPC Handshake & 56-Tool Discovery
await asyncTest('13. Live Stdio MCP Server JSON-RPC handshake lists all 56 tools cleanly', async () => {
  await new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(ROOT, 'bin', 'mcp-server.js')], {
      env: { ...process.env, AGY_SESSION: '1', ADS_KIT_CONFIG: TMP_CFG },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP server timed out waiting for JSON-RPC response'));
    }, 8000);

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n').filter((l) => l.trim().startsWith('{'));
      if (lines.length >= 2) {
        try {
          const responses = lines.map((l) => JSON.parse(l));
          const toolsResp = responses.find((r) => r.id === 2);
          if (toolsResp) {
            clearTimeout(timer);
            assert.strictEqual(toolsResp.result.tools.length, 56);
            child.kill();
            resolve();
          }
        } catch {
          // Wait for complete line
        }
      }
    });

    child.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.includes('PREREQUISITE REQUIRED')) {
        clearTimeout(timer);
        child.kill();
        reject(new Error('MCP server rejected AGY_SESSION'));
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-suite', version: '1.0' } }
      }) + '\n'
    );
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });
});

// Cleanup temporary test directory
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch {
  // ignore Windows file lock
}

console.log(`\nTotal Passed: ${passed} / 13\n`);
if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
