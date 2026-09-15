import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEvent, filterEvents, mergeEvents, sortEvents, severityRank, eventAgeMs } from './eventSchema.js';
import { haversineKm, inIndonesia, pointInGeometry, createAreaLocator, geometryCentroid } from './geo.js';
import { runProvider, runProviderSweep, summarizeHealth } from './sweep.js';
import { computeDelta, compareMetrics } from './delta.js';
import { evaluateAlerts, escalationAlerts, applyAlertCooldown, sourceHealthAlert, pruneAlertMemory } from './alerts.js';
import { correlateEvents, clusterEvents, RELATION_LABELS } from './correlate.js';
import { createIntelMemory } from '../../server/intelligence/memory.js';
import { buildBrief } from './brief.js';

const NOW = Date.parse('2026-09-15T06:00:00Z');
const quake = (overrides = {}) => createEvent({
  id: 'bmkg:1', source: 'bmkg-quakes', type: 'earthquake', timestamp: '2026-09-15T05:30:00Z',
  location: { lat: -8.26, lon: 120.57, depthKm: 7 }, title: 'M3.1 41 km utara Ruteng', severity: 'info',
  magnitude: 3.1, attribution: 'BMKG', raw: { felt: true }, province: 'Nusa Tenggara Timur', provinceCode: '53',
  ...overrides,
});

test('createEvent normalizes fields and rejects records without provenance or usable coordinates', () => {
  const event = quake();
  assert.equal(event.status, 'live');
  assert.equal(event.confidence, 0.5);
  assert.equal(event.country, null);
  assert.equal(event.location.depthKm, 7);
  assert.equal(createEvent({ ...quake(), timestamp: 'not a date' }), null, 'unparseable timestamp');
  assert.equal(createEvent({ ...quake(), attribution: '' }), null, 'attribution is mandatory');
  assert.equal(createEvent({ ...quake(), location: { lat: 95, lon: 0 } }), null, 'latitude out of range');
  const noLocation = createEvent({ ...quake(), location: null });
  assert.equal(noLocation.location, null, 'a news item may have no location');
  assert.equal(createEvent({ ...quake(), severity: 'apocalyptic' }).severity, 'info');
  assert.equal(createEvent({ ...quake(), status: 'fake' }).status, 'live');
  assert.equal(createEvent({ ...quake(), confidence: 7 }).confidence, 1);
  assert.equal(createEvent({ ...quake(), sourceUrl: 'javascript:alert(1)' }).sourceUrl, null);
});

test('mergeEvents keeps the newest record per id and filterEvents applies every filter', () => {
  const older = quake({ severity: 'low', timestamp: '2026-09-15T05:00:00Z' });
  const newer = quake({ severity: 'high', timestamp: '2026-09-15T05:45:00Z' });
  const other = quake({ id: 'usgs:2', type: 'earthquake', source: 'usgs', location: { lat: 1, lon: 100 }, provinceCode: '12', timestamp: '2026-09-14T00:00:00Z' });
  const merged = mergeEvents([older, other], [newer]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((event) => event.id === 'bmkg:1').severity, 'high');
  assert.deepEqual(sortEvents(merged).map((event) => event.id), ['bmkg:1', 'usgs:2']);
  assert.equal(filterEvents(merged, { provinceCode: '53' }).length, 1);
  assert.equal(filterEvents(merged, { minSeverity: 'medium' }).length, 1);
  assert.equal(filterEvents(merged, { sinceMs: Date.parse('2026-09-15T00:00:00Z') }).length, 1);
  assert.equal(filterEvents(merged, { bbox: [119, -9, 121, -7] }).length, 1);
  assert.equal(filterEvents(merged, { types: ['news'] }).length, 0);
  assert.equal(filterEvents(merged, { limit: 1 }).length, 1);
  assert.equal(severityRank('critical'), 4);
  assert.equal(eventAgeMs(newer, NOW), 15 * 60_000);
});

test('geo helpers: distance, Indonesia envelope, point-in-polygon with holes, locator', () => {
  assert.ok(Math.abs(haversineKm(-6.2, 106.8, -6.9, 107.6) - 118) < 3, 'Jakarta–Bandung ≈ 118 km');
  assert.ok(inIndonesia(-6.2, 106.8));
  assert.ok(!inIndonesia(35.7, 139.7));
  const square = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
  assert.ok(pointInGeometry(2, 2, square));
  assert.ok(!pointInGeometry(5, 5, square), 'inside the hole');
  assert.ok(!pointInGeometry(12, 5, square));
  const locator = createAreaLocator({ features: [{ properties: { kdpkab: '31.71', wadmkk: 'Jakarta Pusat' }, geometry: square }] }, { codeKey: 'kdpkab', nameKey: 'wadmkk' });
  assert.deepEqual(locator.locate(1, 1), { code: '31.71', name: 'Jakarta Pusat' });
  assert.equal(locator.locate(50, 50), null);
  assert.deepEqual(geometryCentroid({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]] }), { lat: 1, lon: 1 });
});

function fakeProvider(id, fetch, extra = {}) {
  return { id, name: id.toUpperCase(), category: 'test', attribution: `${id} test data`, fetch, ...extra };
}

test('runProvider applies the timeout, reports not-configured providers, and drops malformed events', async () => {
  const slow = fakeProvider('slow', () => new Promise(() => {}));
  const timedOut = await runProvider(slow, { env: {} }, { timeoutMs: 20 });
  assert.equal(timedOut.state, 'timeout');

  const keyed = fakeProvider('keyed', async () => ({ events: [] }), { envKey: 'X_KEY', isConfigured: (env) => Boolean(env.X_KEY) });
  assert.equal((await runProvider(keyed, { env: {} })).state, 'not-configured');
  assert.equal((await runProvider(keyed, { env: { X_KEY: 'a' } })).state, 'ok');

  const mixed = fakeProvider('mixed', async () => ({
    events: [
      { id: 'ok-1', type: 'earthquake', timestamp: '2026-09-15T05:00:00Z', location: { lat: 1, lon: 2 }, title: 'ok', severity: 'low' },
      { id: 'bad-1', type: 'earthquake', timestamp: 'nope', location: { lat: 1, lon: 2 } },
    ],
    metrics: { count: { value: 2, kind: 'count' } },
  }));
  const result = await runProvider(mixed, { env: {} });
  assert.equal(result.state, 'ok');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].attribution, 'mixed test data', 'provider attribution is stamped');
  assert.equal(result.meta.dropped, 1);

  const failing = fakeProvider('failing', async () => { throw new Error('HTTP 503'); });
  const sweep = await runProviderSweep([mixed, failing, keyed], { env: {} }, { isDue: (provider) => provider.id !== 'keyed' });
  assert.deepEqual(summarizeHealth(sweep.health), { ok: 1, error: 1, timeout: 0, 'not-configured': 0, skipped: 1, total: 3 });
  assert.equal(sweep.events.length, 1);
});

test('computeDelta reports new, escalated, removed events and metric changes over thresholds', () => {
  const previous = { at: 't0', events: [quake({ severity: 'low' }), quake({ id: 'gone' })], metrics: { idr: { value: 15000, kind: 'numeric', threshold: 2 }, quakes: { value: 3, kind: 'count', threshold: 2 } } };
  const current = { at: 't1', events: [quake({ severity: 'high' }), quake({ id: 'fresh', severity: 'critical' }), quake({ id: 'seen-before' })], metrics: { idr: { value: 15600, kind: 'numeric', threshold: 2 }, quakes: { value: 4, kind: 'count', threshold: 2 } } };
  const delta = computeDelta(current, previous, { priorIds: ['seen-before'] });
  assert.deepEqual(delta.newEvents.map((event) => event.id), ['fresh'], 'an id seen in older runs is not new again');
  assert.equal(delta.escalated[0].to, 'high');
  assert.deepEqual(delta.removed.map((event) => event.id), ['gone']);
  assert.equal(delta.metricChanges.length, 1, 'the count moved by 1, under its threshold of 2');
  assert.equal(delta.metricChanges[0].key, 'idr');
  assert.equal(delta.metricChanges[0].pctChange, 4);
  assert.equal(delta.summary.criticalChanges, 2);
  assert.equal(computeDelta(current, null), null);
  assert.deepEqual(compareMetrics({ a: { value: 'x' } }, { a: { value: 1 } }), []);
});

test('alert rules are transparent and cooldowns suppress repeats progressively', () => {
  const events = [
    quake({ id: 'q7', magnitude: 7.2, severity: 'critical' }),
    quake({ id: 'q5', magnitude: 5.1, severity: 'medium' }),
    quake({ id: 'qt', magnitude: 6.0, severity: 'high', raw: { tsunamiPotential: true } }),
    quake({ id: 'v3', type: 'volcano', title: 'Merapi', raw: { alertLevel: 3 } }),
    quake({ id: 'f1', type: 'flood', title: 'Banjir Demak', raw: { impact: { deaths: 2, displaced: 900 } } }),
    quake({ id: 'w1', type: 'weather', title: 'Jakarta forecast', severity: 'medium', raw: { severe: 'Heavy rain' } }),
    quake({ id: 'quiet', magnitude: 2.0, raw: {} }),
  ];
  const alerts = evaluateAlerts(events, { nowMs: NOW });
  const byId = Object.fromEntries(alerts.map((alert) => [alert.eventIds[0], alert]));
  assert.equal(byId.q7.level, 'CRITICAL');
  assert.equal(byId.qt.rule, 'tsunami-potential');
  assert.equal(byId.q5.level, 'MEDIUM');
  assert.equal(byId.v3.level, 'HIGH');
  assert.equal(byId.f1.level, 'HIGH');
  assert.equal(byId.w1.level, 'LOW');
  assert.equal(byId.quiet, undefined, 'a small unfelt quake raises nothing');
  assert.equal(alerts[0].level, 'CRITICAL', 'sorted by level');
  for (const alert of alerts) {
    assert.ok(alert.source && alert.timestamp && alert.reason && Number.isFinite(alert.confidence));
  }
  assert.equal(evaluateAlerts([quake({ id: 'v2', type: 'volcano', raw: { alertLevel: 2 } })], { nowMs: NOW }).length, 0, 'a steady Level II is not an alert');
  assert.equal(evaluateAlerts([quake({ id: 'old5', magnitude: 5.4, severity: 'medium', timestamp: '2026-09-01T00:00:00Z' })], { nowMs: NOW }).length, 0, 'a two-week-old M5 is history, not an alert');
  const escalations = escalationAlerts({ escalated: [{ event: quake({ id: 'v2', type: 'volcano', title: 'Merapi', severity: 'high', raw: { alertLevel: 3 } }), from: 'medium', to: 'high' }] });
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].level, 'HIGH');
  assert.match(escalations[0].reason, /rose from medium to high/);

  let memory = {};
  const first = applyAlertCooldown([byId.q5], memory, { nowMs: NOW });
  assert.equal(first.raised.length, 1);
  memory = first.alerted;
  const repeat = applyAlertCooldown([byId.q5], memory, { nowMs: NOW + 3_600_000 });
  assert.equal(repeat.raised.length, 0, 'second occurrence within 6 h is suppressed');
  const later = applyAlertCooldown([byId.q5], memory, { nowMs: NOW + 7 * 3_600_000 });
  assert.equal(later.raised.length, 1);
  assert.equal(later.alerted[byId.q5.key].count, 2);
  assert.deepEqual(pruneAlertMemory(later.alerted, { nowMs: NOW + 30 * 24 * 3_600_000 }), {});

  assert.equal(sourceHealthAlert([{ id: 'a', state: 'error', error: 'x' }]), null);
  assert.equal(sourceHealthAlert([{ id: 'a', state: 'error', error: 'x' }, { id: 'b', state: 'timeout' }]).level, 'INFO');
});

test('correlation reports related signals with fixed non-causal wording and clusters same-type events', () => {
  const events = [
    quake({ id: 'q', type: 'earthquake', timestamp: '2026-09-15T05:00:00Z' }),
    quake({ id: 'n', type: 'news', title: 'Gempa Manggarai', timestamp: '2026-09-15T06:00:00Z', location: { lat: -8.3, lon: 120.6 } }),
    quake({ id: 'far', type: 'flood', location: { lat: -6.2, lon: 106.8 } }),
    quake({ id: 'old', type: 'volcano', timestamp: '2026-09-01T00:00:00Z', location: { lat: -8.2, lon: 120.5 } }),
  ];
  const related = correlateEvents(events);
  const forQuake = related.get('q');
  assert.deepEqual(forQuake.map((entry) => entry.eventId), ['n', 'old']);
  assert.equal(forQuake[0].relation, RELATION_LABELS.both);
  assert.equal(forQuake[1].relation, RELATION_LABELS.spatial);
  assert.equal(related.has('far'), false);
  assert.ok(Object.values(RELATION_LABELS).every((label) => !/cause/i.test(label)));

  const fires = ['a', 'b', 'c', 'd'].map((id, index) => quake({ id, type: 'fire', location: { lat: -1.1 - index * 0.01, lon: 110.2 } }));
  const clusters = clusterEvents([...fires, ...events], { type: 'fire' });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 4);
});

test('memory persists compact runs atomically, archives overflow, and tracks alert cooldowns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gev-intel-'));
  const memory = createIntelMemory(dir, { maxHotRuns: 2, log: { warn() {} } });
  assert.equal(memory.lastRun(), null);
  assert.equal(memory.addRun({ at: '2026-09-15T01:00:00Z', events: [quake()], metrics: {} }), null);
  memory.addRun({ at: '2026-09-15T02:00:00Z', events: [quake({ id: 'second' })], metrics: {} });
  memory.addRun({ at: '2026-09-15T03:00:00Z', events: [], metrics: {} });
  assert.equal(memory.runs().length, 2, 'overflow archived to cold storage');
  assert.ok(existsSync(join(dir, 'cold', '2026-09-15.jsonl')));
  assert.deepEqual([...memory.knownEventIds()], ['second']);
  memory.setAlerted({ 'x:1': { count: 1, lastAt: NOW } });
  const reloaded = createIntelMemory(dir, { maxHotRuns: 2, log: { warn() {} } });
  assert.equal(reloaded.getAlerted()['x:1'].count, 1);
  const raw = JSON.parse(readFileSync(join(dir, 'hot.json'), 'utf8'));
  assert.equal(raw.runs[0].events.length, 0);
  assert.ok(!('description' in (raw.runs[1].events[0] || {})), 'runs are compacted');
});

test('brief lines carry source, timestamp, freshness, and the sources section', () => {
  const events = [
    quake({ magnitude: 5.4, severity: 'medium', title: 'M5.4 Maluku', timestamp: new Date(NOW - 3_600_000).toISOString() }),
    quake({ id: 'ancient', timestamp: '2026-01-01T00:00:00Z' }),
    quake({ id: 'v', type: 'volcano', title: 'Semeru', severity: 'high', timestamp: new Date(NOW - 60_000).toISOString() }),
  ];
  const brief = buildBrief({
    events,
    alerts: evaluateAlerts(events, { nowMs: NOW }),
    health: [{ id: 'bmkg-quakes', name: 'BMKG', state: 'ok' }, { id: 'reliefweb', name: 'ReliefWeb', state: 'not-configured' }, { id: 'gdelt', name: 'GDELT', state: 'error', error: 'HTTP 429' }],
    nowMs: NOW,
  });
  assert.equal(brief.signalCount, 2, 'events outside the window are excluded');
  assert.deepEqual(brief.sections.map((section) => section.type), ['earthquake', 'volcano']);
  assert.equal(brief.highestSeverity, 'high');
  assert.match(brief.sections[0].lines[0], /\[bmkg-quakes · 2026-09-15T05:00:00.000Z · 1 h ago · live\]/);
  assert.match(brief.text, /Not configured: ReliefWeb/);
  assert.match(brief.text, /Failing: GDELT \(HTTP 429\)/);
  assert.match(brief.text, /related signals, not confirmed causes/);
});
