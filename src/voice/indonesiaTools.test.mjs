import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDONESIA_TOOL_NAMES, resolvePlace, resolveProvince, runIndonesiaTool } from './indonesiaTools.js';

const provinces = [
  { code: '31', name: 'DKI Jakarta', capital: 'Jakarta', lat: -6.208, lon: 106.846 },
  { code: '32', name: 'Jawa Barat', capital: 'Bandung', lat: -6.914, lon: 107.609 },
  { code: '51', name: 'Bali', capital: 'Denpasar', lat: -8.67, lon: 115.212 },
];
const pack = {
  provinces,
  cities: [],
  weatherPoints: [{ id: 'surabaya', name: 'Surabaya', lat: -7.257, lon: 112.752 }],
  regencies: [{ code: '32.73', name: 'Kota Bandung', centroid: { lat: -6.91, lon: 107.6 } }],
  airports: [{ name: 'Husein Sastranegara', ident: 'WICC', lat: -6.9, lon: 107.58 }],
  volcanoes: [{ name: 'Tangkuban Perahu', lat: -6.77, lon: 107.6 }],
};
const events = [
  { id: 'q1', type: 'earthquake', title: 'M5.1 Bandung', severity: 'medium', status: 'live', timestamp: '2026-09-15T05:00:00Z', location: { lat: -6.95, lon: 107.65 }, provinceCode: '32', province: 'Jawa Barat', source: 'bmkg-quakes', attribution: 'BMKG', magnitude: 5.1 },
  { id: 'n1', type: 'news', title: 'Berita Bali', severity: 'info', status: 'live', timestamp: '2026-09-15T04:00:00Z', location: { lat: -8.6, lon: 115.2 }, provinceCode: '51', source: 'gdelt-indonesia', attribution: 'GDELT' },
];

function fakeClient({ status = {}, brief = {} } = {}) {
  const calls = [];
  return {
    calls,
    getPack: async () => pack,
    getEvents: async (params) => { calls.push(['events', params]); const scoped = params.scope?.startsWith('province:') ? events.filter((event) => event.provinceCode === params.scope.slice(9)) : events; return { count: scoped.length, events: scoped }; },
    getBrief: async (params) => { calls.push(['brief', params]); return { scope: { name: params.scope === 'province:32' ? 'Jawa Barat' : 'Indonesia' }, generatedAt: 'now', windowHours: params.hours || 72, headline: 'h', highestSeverity: 'medium', signalCount: 1, alerts: [], sections: [], sources: {}, ...brief }; },
    getStatus: async () => ({ lastSweepAt: 'now', summary: { ok: 1 }, eventCount: 2, activeAlerts: 0, health: [{ id: 'bmkg-quakes', name: 'BMKG', category: 'earthquake', state: 'ok', configured: true, envKey: null, intervalMs: 300000, eventCount: 2 }, { id: 'reliefweb-indonesia', name: 'ReliefWeb', category: 'disaster', state: 'not-configured', configured: false, envKey: 'RELIEFWEB_APPNAME', intervalMs: 3600000, eventCount: 0 }], ...status }),
  };
}

test('provinces resolve from codes, short forms, and partial names; places from names or "lat,lon"', () => {
  assert.equal(resolveProvince('32', provinces).name, 'Jawa Barat');
  assert.equal(resolveProvince('jabar', provinces).code, '32');
  assert.equal(resolveProvince('West Java', provinces), null, 'English names are not guessed');
  assert.equal(resolveProvince('bali', provinces).code, '51');
  assert.equal(resolveProvince('Jakarta', provinces).code, '31');
  assert.deepEqual(resolvePlace('-6.2, 106.8'), { name: '-6.2, 106.8', lat: -6.2, lon: 106.8 });
  assert.equal(resolvePlace('95,0'), null);
  assert.equal(resolvePlace('Bandung', pack).kind, 'capital');
  assert.equal(resolvePlace('Surabaya', pack).kind, 'city');
  assert.equal(resolvePlace('Kota Bandung', pack).kind, 'regency');
  assert.equal(resolvePlace('Atlantis', pack), null);
});

test('runIndonesiaTool ignores foreign names and answers queries with scope labels and provenance', async () => {
  const client = fakeClient();
  assert.equal(await runIndonesiaTool('fly_to_location', {}, { client }), null);
  assert.deepEqual(INDONESIA_TOOL_NAMES.length, 9);

  const listed = await runIndonesiaTool('query_events', { province: 'Jawa Barat', hours: 24, limit: 5 }, { client, indonesia: null });
  assert.equal(listed.count, 1);
  assert.equal(listed.events[0].freshness, 'LIVE');
  assert.equal(listed.events[0].attribution, 'BMKG');
  assert.match(listed.scopeLabel, /Jawa Barat · last 24 h/);
  assert.equal(client.calls.at(-1)[1].scope, 'province:32');

  const unknown = await runIndonesiaTool('query_events', { province: 'Narnia' }, { client });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown province/);

  const nearby = await runIndonesiaTool('query_nearby_events', { place: 'Bandung', radiusKm: 50 }, { client });
  assert.equal(nearby.count, 1);
  assert.equal(nearby.events[0].id, 'q1');
  assert.ok(nearby.events[0].distanceKm < 10);

  const summary = await runIndonesiaTool('get_indonesia_summary', { province: '32', hours: 48 }, { client });
  assert.equal(summary.scope.name, 'Jawa Barat');
  assert.match(summary.note, /not confirmed causes/);

  const sources = await runIndonesiaTool('get_data_source_status', {}, { client });
  assert.equal(sources.sources[1].state, 'NOT-CONFIGURED');
  assert.equal(sources.sources[1].needsKey, 'RELIEFWEB_APPNAME');

  const measured = await runIndonesiaTool('measure_distance', { from: 'Jakarta', to: 'Bandung' }, { client });
  assert.ok(measured.distanceKm > 110 && measured.distanceKm < 125);
  assert.match(measured.from.dms, /S .*E$/);

  const buffered = await runIndonesiaTool('spatial_buffer', { place: 'Bandung', radiusKm: 30 }, { client, indonesia: null });
  assert.equal(buffered.eventCount, 1);
  assert.equal(buffered.nearestAirport.ident, 'WICC');
  assert.equal(buffered.nearestVolcano.name, 'Tangkuban Perahu');
  assert.equal(buffered.drawnOnGis, false);
});

test('mode, map, and timeline tools drive the command center and report honestly when it is absent', async () => {
  const client = fakeClient();
  const missing = await runIndonesiaTool('set_indonesia_mode', { enabled: true }, { client, indonesia: null });
  assert.equal(missing.ok, false);

  const calls = [];
  let state = { enabled: false, provinceCode: null, mapMode: '3d', timelineHours: 72, timelinePlaying: false };
  const indonesia = {
    state: { get: () => state, set: (patch) => { state = { ...state, ...patch }; } },
    setIndonesiaMode: async (enabled) => { calls.push(['mode', enabled]); state.enabled = enabled; },
    setMapMode: async (mode) => { calls.push(['map', mode]); state.mapMode = mode; },
    getMapMode: () => state.mapMode,
    showTab: (tab) => calls.push(['tab', tab]),
    setTimelinePlaying: (playing) => { state.timelinePlaying = playing; },
    selectEvent: () => {},
    getGisMap: () => null,
  };
  const on = await runIndonesiaTool('set_indonesia_mode', { enabled: true, province: 'Bali', tab: 'events' }, { client, indonesia });
  assert.deepEqual(on, { ok: true, action: 'set_indonesia_mode', enabled: true, province: { code: '51', name: 'Bali' }, mapMode: '3d' });
  assert.deepEqual(calls, [['mode', true], ['tab', 'events']]);
  assert.equal((await runIndonesiaTool('set_map_mode', { mode: 'gis' }, { client, indonesia })).mode, 'gis');
  const timeline = await runIndonesiaTool('set_timeline_range', { hours: 24, playing: true }, { client, indonesia });
  assert.deepEqual([timeline.hours, timeline.playing], [24, true]);
});
