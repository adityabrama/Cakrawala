import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createIntelEngine, parseScope } from './server.js';
import { parseEventQuery } from '../../server/intelligence/vitePlugin.js';

const T0 = Date.parse('2026-09-15T06:00:00Z');

function makeClock(start = T0) {
  let nowMs = start;
  const timers = [];
  return {
    now: () => nowMs,
    advance(ms) { nowMs += ms; },
    setTimer: (fn, ms) => { const id = { fn, at: nowMs + ms }; timers.push(id); return id; },
    clearTimer: (id) => { const index = timers.indexOf(id); if (index >= 0) timers.splice(index, 1); },
    async runDue() {
      const due = timers.filter((timer) => timer.at <= nowMs);
      for (const timer of due) { timers.splice(timers.indexOf(timer), 1); await timer.fn(); }
      await new Promise((resolve) => setImmediate(resolve));
    },
    pending: () => timers.length,
  };
}

function provider(id, { intervalMs = 60_000, category = 'earthquake', events = () => [], metrics = () => ({}), fail = false, meta = () => ({}) } = {}) {
  let calls = 0;
  return {
    id, name: id, category, region: 'ID', auth: 'keyless', envKey: null, intervalMs, attribution: `${id} attribution`, license: '', sourceUrl: null,
    isConfigured: () => true,
    calls: () => calls,
    async fetch() {
      calls += 1;
      if (fail) throw new Error('upstream down');
      return { events: events(calls), metrics: metrics(calls), meta: meta(calls) };
    },
  };
}

const quake = (id, overrides = {}) => ({
  id, type: 'earthquake', timestamp: new Date(T0 - 600_000).toISOString(), location: { lat: -6.9, lon: 107.6 },
  title: `Quake ${id}`, severity: 'medium', magnitude: 5.2, provinceCode: '32', province: 'Jawa Barat', raw: {}, ...overrides,
});

const pack = {
  provinceByCode: (code) => (code === '32' ? { code: '32', name: 'Jawa Barat', bbox: [105, -8, 109, -5] } : null),
};

test('engine sweeps due providers on their own cadence and keeps previous events when a provider fails', async () => {
  const clock = makeClock();
  const fast = provider('fast', { intervalMs: 60_000, events: (n) => [quake(`fast-${n}`)] });
  const slow = provider('slow', { intervalMs: 600_000, events: () => [quake('slow-1', { severity: 'low', magnitude: 3 })] });
  const down = provider('down', { fail: true });
  const engine = createIntelEngine({ providers: [fast, slow, down], pack, log: { log() {}, warn() {} }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, tickMs: 60_000 });
  const sweeps = [];
  engine.subscribe((message) => sweeps.push(message));

  engine.start({ firstSweepDelayMs: 1000 });
  clock.advance(1000);
  await clock.runDue();
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].ok, 2);
  assert.equal(sweeps[0].failed, 1);
  assert.equal(engine.getEvents().length, 2);
  const health = Object.fromEntries(engine.getHealth().map((entry) => [entry.id, entry]));
  assert.equal(health.down.state, 'error');
  assert.match(health.down.error, /upstream down/);
  assert.equal(health.slow.state, 'ok');

  clock.advance(61_000);
  await clock.runDue();
  assert.equal(fast.calls(), 2, 'the 60 s provider ran again');
  assert.equal(slow.calls(), 1, 'the 10 min provider did not');
  assert.equal(down.calls(), 1, 'a failed provider backs off for at least two minutes');
  assert.deepEqual(engine.getEvents({ types: ['earthquake'] }).map((event) => event.id).sort(), ['fast-1', 'fast-2', 'slow-1'].sort(), 'newest fast run replaced its events; the earlier fast-1 stays through merge within retention');
  engine.stop();
  assert.equal(clock.pending(), 0);
});

test('engine raises alerts with cooldown, exposes deltas, scoped events, and briefs', async () => {
  const clock = makeClock();
  let magnitude = 5.5;
  const bmkg = provider('bmkg', { events: () => [quake('big', { magnitude, severity: magnitude >= 6 ? 'high' : 'medium', raw: { felt: true } })], metrics: () => ({ felt: { value: 1, kind: 'count', threshold: 1 } }) });
  const outside = provider('outside', { events: () => [quake('far', { location: { lat: 35, lon: 139 }, provinceCode: null, province: null, severity: 'high', magnitude: 6.1 })] });
  const engine = createIntelEngine({ providers: [bmkg, outside], pack, log: { log() {}, warn() {} }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  await engine.sweep({ force: true });
  const alerts = engine.getAlerts();
  assert.equal(alerts.length, 2);
  assert.equal(engine.getAlerts({ scope: 'province:32' }).length, 1);
  assert.equal(engine.getAlerts({ minLevel: 'HIGH' }).length, 1);
  assert.equal(engine.getEvents({ scope: 'indonesia' }).length, 1, 'the Indonesia scope excludes the event in Japan');
  assert.equal(engine.getEvents({ scope: 'province:32' })[0].id, 'big');
  assert.equal(engine.getDelta(), null, 'no previous run to compare');

  magnitude = 6.3;
  clock.advance(120_000);
  await engine.sweep({ force: true });
  assert.equal(engine.getDelta().escalated.length, 1);
  const afterEscalation = engine.getAlerts();
  assert.equal(afterEscalation.length, 3, 'the rule alert stays in cooldown; the escalation itself is one new alert');
  assert.equal(afterEscalation.filter((alert) => alert.rule === 'escalation').length, 1);
  const status = engine.getStatus();
  assert.equal(status.eventCount, 2);
  assert.equal(status.summary.ok, 2);
  assert.deepEqual(status.counts.byType, { earthquake: 2 });

  const brief = engine.getBrief({ scope: 'province:32' });
  assert.equal(brief.scope.name, 'Jawa Barat');
  assert.equal(brief.signalCount, 1);
  assert.match(brief.text, /Reporting: bmkg, outside/);
  assert.equal(engine.getEvent('big').related.length, 0);
  assert.equal(engine.getEvent('missing'), null);
});

test('queryPoint fans out to configured on-demand providers and isolates failures', async () => {
  const engine = createIntelEngine({
    providers: [],
    onDemand: [
      { id: 'weather', isConfigured: () => true, query: async ({ lat }) => ({ tempC: lat }) },
      { id: 'broken', isConfigured: () => true, query: async () => { throw new Error('boom'); } },
      { id: 'keyed', isConfigured: () => false, query: async () => ({ never: true }) },
    ],
    log: { log() {}, warn() {} },
  });
  const result = await engine.queryPoint({ lat: -6.2, lon: 106.8 });
  assert.deepEqual(result, { weather: { tempC: -6.2 }, broken: { error: 'boom' } });
});

test('parseScope and parseEventQuery validate every input', () => {
  assert.deepEqual(parseScope('province:32', pack), { kind: 'province', code: '32', name: 'Jawa Barat', bbox: [105, -8, 109, -5] });
  assert.equal(parseScope('bbox:1,2,3,4').kind, 'bbox');
  assert.equal(parseScope('bbox:1,x').kind, 'indonesia');
  assert.equal(parseScope(undefined).name, 'Indonesia');
  const filter = parseEventQuery(new URLSearchParams('types=earthquake,volcano&severity=medium&province=32&hours=6&limit=99999&status=live'));
  assert.deepEqual(filter.types, ['earthquake', 'volcano']);
  assert.equal(filter.minSeverity, 'medium');
  assert.equal(filter.scope, 'province:32');
  assert.equal(filter.limit, 2000);
  assert.deepEqual(filter.statuses, ['live']);
  assert.ok(Number.isFinite(filter.sinceMs));
  assert.equal(parseEventQuery(new URLSearchParams('severity=nope&limit=-1')).limit, 500);
  assert.equal(parseEventQuery(new URLSearchParams('bbox=100,-10,120,5')).scope, 'bbox:100,-10,120,5');
  assert.deepEqual(parseEventQuery(new URLSearchParams('exclude=news,economy')).excludeTypes, ['news', 'economy']);
  assert.equal(parseEventQuery(new URLSearchParams('types=news')).excludeTypes, undefined);
});

test('a flood of fresh headlines can never push older disaster events out of a capped read', async () => {
  const news = Array.from({ length: 30 }, (_, index) => ({
    id: `news-${index}`, type: 'news', timestamp: new Date(T0 - index * 1000).toISOString(), location: null,
    country: 'ID', title: `Headline ${index}`, severity: 'info', raw: {},
  }));
  const oldQuake = quake('old', { timestamp: new Date(T0 - 2 * 86_400_000).toISOString() });
  const engine = createIntelEngine({
    providers: [provider('mixed', { events: () => [oldQuake, ...news] })],
    pack,
    log: { log() {}, warn() {} },
  });
  await engine.sweep({ force: true });
  assert.ok(!engine.getEvents({ limit: 10 }).some((event) => event.id === 'old'), 'an unsplit capped read loses the older quake');
  assert.deepEqual(engine.getEvents({ limit: 10, excludeTypes: ['news'] }).map((event) => event.id), ['old']);
  assert.equal(engine.getEvents({ limit: 10, types: ['news'] }).length, 10);
});

test('the Indonesia scope keeps Indonesian events that have no position; a drawn bbox does not', async () => {
  const engine = createIntelEngine({
    providers: [provider('mixed', {
      events: () => [
        { id: 'headline', type: 'news', timestamp: new Date(T0).toISOString(), location: null, country: 'ID', title: 'Headline without a place', severity: 'info', raw: {} },
        { id: 'foreign', type: 'news', timestamp: new Date(T0).toISOString(), location: null, country: 'JP', title: 'Foreign headline', severity: 'info', raw: {} },
        { id: 'tokyo', type: 'earthquake', timestamp: new Date(T0).toISOString(), location: { lat: 35.7, lon: 139.7 }, country: 'JP', title: 'Quake in Japan', severity: 'medium', raw: {} },
        quake('bandung'),
      ],
    })],
    pack,
    log: { log() {}, warn() {} },
  });
  await engine.sweep({ force: true });
  assert.deepEqual(engine.getEvents().map((event) => event.id).sort(), ['bandung', 'headline'], 'default scope: positioned inside Indonesia plus unpositioned Indonesian');
  assert.deepEqual(engine.getEvents({ scope: 'bbox:105,-8,109,-5' }).map((event) => event.id), ['bandung'], 'a drawn area only contains positioned events');
});

test('a rate-limited provider (HTTP 429) waits at least 30 minutes instead of retrying every 2', async () => {
  const clock = makeClock();
  const limited = {
    ...provider('limited', { intervalMs: 60_000 }),
    calls: undefined,
  };
  let limitedCalls = 0;
  limited.fetch = async () => {
    limitedCalls += 1;
    const error = new Error('HTTP 429 from api.gdeltproject.org: Please limit requests');
    error.status = 429;
    throw error;
  };
  const down = provider('down', { intervalMs: 60_000, fail: true });
  const engine = createIntelEngine({ providers: [limited, down], pack, log: { log() {}, warn() {} }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, tickMs: 60_000 });
  engine.start({ firstSweepDelayMs: 1000 });
  clock.advance(1000);
  await clock.runDue();
  assert.equal(limitedCalls, 1);
  assert.equal(down.calls(), 1);

  for (let minute = 0; minute < 5; minute += 1) {
    clock.advance(60_000);
    await clock.runDue();
  }
  assert.ok(down.calls() >= 2, 'an ordinary failure retries after two minutes');
  assert.equal(limitedCalls, 1, 'a 429 does not');

  for (let minute = 0; minute < 27; minute += 1) {
    clock.advance(60_000);
    await clock.runDue();
  }
  assert.equal(limitedCalls, 2, 'the rate-limited provider retries after its 30-minute backoff');
  engine.stop();
});
