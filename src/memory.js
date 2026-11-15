import fs from 'fs';
import path from 'path';
import { resolveStorageDir } from './config.js';

function getMemoryDir() {
  return path.resolve(resolveStorageDir(), 'memory');
}

function getRunsDir() {
  return path.resolve(resolveStorageDir(), 'runs');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // fallback to default if corrupted
  }
  return defaultValue;
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Generates a deterministic fingerprint for a Google Ads change_event row.
 */
export function buildChangeFingerprint(row) {
  const ce = row?.changeEvent || {};
  return [
    ce.changeDateTime || '',
    ce.changeResourceType || '',
    ce.resourceChangeOperation || '',
    ce.changeResourceName || '',
    ce.userEmail || ''
  ].join('|');
}

/**
 * Syncs fetched Google Ads change_event items into persistent Episodic Memory ledger.
 * Returns { newEvents, totalTracked, ledger }.
 */
export function syncChangeEventsToLedger(customerId, rawEvents = []) {
  const ledgerPath = path.join(getMemoryDir(), 'change-events-ledger.json');
  const ledger = readJsonFile(ledgerPath, { updatedAt: null, byCustomer: {} });
  if (!ledger.byCustomer[customerId]) {
    ledger.byCustomer[customerId] = {};
  }
  const store = ledger.byCustomer[customerId];
  const newEvents = [];

  for (const row of rawEvents) {
    const fp = buildChangeFingerprint(row);
    const ce = row?.changeEvent || {};
    if (!store[fp]) {
      const record = {
        fingerprint: fp,
        firstSeenAt: new Date().toISOString(),
        changeDateTime: ce.changeDateTime || null,
        resourceType: ce.changeResourceType || null,
        operation: ce.resourceChangeOperation || null,
        resourceName: ce.changeResourceName || null,
        campaign: ce.campaign || null,
        adGroup: ce.adGroup || null,
        userEmail: ce.userEmail || null,
        clientType: ce.clientType || null,
        changedFields: ce.changedFields || [],
        oldResource: ce.oldResource || null,
        newResource: ce.newResource || null,
        impactAssessment: null
      };
      store[fp] = record;
      newEvents.push(record);
    }
  }

  ledger.updatedAt = new Date().toISOString();
  writeJsonFile(ledgerPath, ledger);

  return {
    newEvents,
    totalTracked: Object.keys(store).length,
    events: Object.values(store).sort((a, b) =>
      String(b.changeDateTime || '').localeCompare(String(a.changeDateTime || ''))
    )
  };
}

export function saveEventImpactAssessment(customerId, fingerprint, impactAssessment) {
  const ledgerPath = path.join(getMemoryDir(), 'change-events-ledger.json');
  const ledger = readJsonFile(ledgerPath, { updatedAt: null, byCustomer: {} });
  if (ledger.byCustomer[customerId]?.[fingerprint]) {
    ledger.byCustomer[customerId][fingerprint].impactAssessment = {
      evaluatedAt: new Date().toISOString(),
      ...impactAssessment
    };
    ledger.updatedAt = new Date().toISOString();
    writeJsonFile(ledgerPath, ledger);
  }
}

export function getTrackedChangeEvents(customerId) {
  const ledgerPath = path.join(getMemoryDir(), 'change-events-ledger.json');
  const ledger = readJsonFile(ledgerPath, { updatedAt: null, byCustomer: {} });
  const store = ledger.byCustomer[customerId] || {};
  return Object.values(store).sort((a, b) =>
    String(b.changeDateTime || '').localeCompare(String(a.changeDateTime || ''))
  );
}

/**
 * Records an executed (or dry-run validated) mutation decision made via a CLI Agent.
 */
export function recordDecision({
  agentId,
  toolName,
  customerId,
  dryRun = false,
  summaryTitle,
  payload,
  response,
  baselineSnapshot = null
}) {
  const logPath = path.join(getMemoryDir(), 'decision-log.json');
  const data = readJsonFile(logPath, { decisions: [] });
  const entry = {
    id: `DEC-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    timestamp: new Date().toISOString(),
    agentId,
    toolName,
    customerId: customerId || null,
    dryRun: Boolean(dryRun),
    summaryTitle: summaryTitle || toolName,
    payload,
    response,
    baselineSnapshot
  };
  data.decisions.unshift(entry);
  if (data.decisions.length > 500) {
    data.decisions = data.decisions.slice(0, 500);
  }
  writeJsonFile(logPath, data);
  return entry;
}

export function getDecisions(limit = 50) {
  const logPath = path.join(getMemoryDir(), 'decision-log.json');
  const data = readJsonFile(logPath, { decisions: [] });
  return (data.decisions || []).slice(0, limit);
}

/**
 * Stores discovered messaging angles in persistent knowledge base for R&D Angle Evolution Tracking.
 */
export function saveAngleKnowledgeEntry(customerId, entry) {
  const kbPath = path.join(getMemoryDir(), 'angle-knowledge-base.json');
  const kb = readJsonFile(kbPath, { byCustomer: {} });
  if (!kb.byCustomer[customerId]) kb.byCustomer[customerId] = [];
  kb.byCustomer[customerId].unshift({
    recordedAt: new Date().toISOString(),
    ...entry
  });
  kb.byCustomer[customerId] = kb.byCustomer[customerId].slice(0, 100);
  writeJsonFile(kbPath, kb);
  return kbPath;
}

export function getAngleKnowledgeBase(customerId) {
  const kbPath = path.join(getMemoryDir(), 'angle-knowledge-base.json');
  const kb = readJsonFile(kbPath, { byCustomer: {} });
  return kb.byCustomer[customerId] || [];
}

/**
 * Saves an agent report / analysis artifact into storage/runs/.
 */
export function saveAgentRunReport(agentId, payload) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(getRunsDir(), `${agentId}-${ts}.json`);
  writeJsonFile(outPath, payload);
  return outPath;
}
