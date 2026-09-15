/**
 * @module voice/indonesiaTools
 *
 * Voice/AI tools for the Indonesia command center, the intelligence engine,
 * and the GIS toolbox. Every tool returns structured data taken from the
 * engine or computed here; none claims success without a result. The runner
 * returns `null` for names it does not own so the main action runner keeps
 * its existing dispatch untouched.
 */

import { intelClient } from '../indonesia/intelClient.js';
import { EVENT_TYPE_GROUPS } from '../indonesia/indonesiaState.js';
import { viewCenter } from '../indonesia/indonesiaCamera.js';
import { bufferKm, distanceKm, bearingDeg, eventsWithinRadius, nearestFeature, makePoint, areaKm2, toDms } from '../gis/spatialTools.js';

export const INDONESIA_TOOL_NAMES = Object.freeze([
  'set_indonesia_mode', 'set_map_mode', 'get_indonesia_summary', 'query_events', 'query_nearby_events',
  'get_data_source_status', 'set_timeline_range', 'measure_distance', 'spatial_buffer',
]);

const PROVINCE_SHORT = Object.freeze({
  jakarta: '31', dki: '31', jabar: '32', jateng: '33', jatim: '35', jogja: '34', yogya: '34', diy: '34', ntb: '52', ntt: '53',
  sumut: '12', sumbar: '13', sumsel: '16', babel: '19', kepri: '21', kalbar: '61', kalteng: '62', kalsel: '63', kaltim: '64', kaltara: '65',
  sulut: '71', sulteng: '72', sulsel: '73', sultra: '74', sulbar: '76', malut: '82',
});

function normalize(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Resolve a province code from a code, short form, or (partial) name. Pure. */
export function resolveProvince(input, provinces = []) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (/^\d{2}$/.test(raw)) return provinces.find((province) => province.code === raw) || { code: raw, name: `Province ${raw}` };
  const key = normalize(raw);
  const short = PROVINCE_SHORT[key];
  if (short) return provinces.find((province) => province.code === short) || { code: short, name: raw };
  const exact = provinces.find((province) => normalize(province.name) === key);
  if (exact) return exact;
  const partial = provinces.filter((province) => normalize(province.name).includes(key) || key.includes(normalize(province.name)));
  return partial.length === 1 ? partial[0] : null;
}

/** Resolve "lat,lon" or a bundled place (province capital, regency, city) to coordinates. Pure. */
export function resolvePlace(input, pack = null) {
  const raw = String(input ?? '').trim();
  const pair = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (pair) {
    const lat = Number(pair[1]);
    const lon = Number(pair[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { name: raw, lat, lon };
  }
  if (!pack) return null;
  const key = normalize(raw);
  const candidates = [
    ...(pack.cities || []).map((city) => ({ name: city.name, lat: city.lat, lon: city.lon, kind: 'city' })),
    ...(pack.weatherPoints || []).map((point) => ({ name: point.name, lat: point.lat, lon: point.lon, kind: 'city' })),
    ...(pack.provinces || []).flatMap((province) => [{ name: province.capital, lat: province.lat, lon: province.lon, kind: 'capital' }, { name: province.name, lat: province.lat, lon: province.lon, kind: 'province' }]),
    ...(pack.regencies || []).filter((regency) => regency.centroid).map((regency) => ({ name: regency.name, lat: regency.centroid.lat, lon: regency.centroid.lon, kind: 'regency' })),
  ].filter((candidate) => Number.isFinite(candidate.lat) && Number.isFinite(candidate.lon));
  const exact = candidates.find((candidate) => normalize(candidate.name) === key);
  if (exact) return exact;
  const stripped = candidates.find((candidate) => normalize(candidate.name).replace(/^(kota|kabupaten) /, '') === key);
  if (stripped) return stripped;
  const partial = candidates.filter((candidate) => normalize(candidate.name).includes(key));
  return partial.length ? partial[0] : null;
}

function compactEvent(event) {
  return {
    id: event.id,
    type: event.type,
    subtype: event.subtype,
    title: event.title,
    severity: event.severity,
    freshness: String(event.status || '').toUpperCase(),
    timestamp: event.timestamp,
    lat: event.location?.lat ?? null,
    lon: event.location?.lon ?? null,
    province: event.province,
    city: event.city,
    magnitude: event.magnitude ?? null,
    source: event.source,
    sourceUrl: event.sourceUrl,
    attribution: event.attribution,
    ...(Number.isFinite(event.distanceKm) ? { distanceKm: Math.round(event.distanceKm * 10) / 10 } : {}),
  };
}

function typeList(types) {
  if (!Array.isArray(types) || !types.length) return null;
  const known = new Set(EVENT_TYPE_GROUPS.flatMap((group) => group.types));
  const out = [];
  for (const type of types) {
    const key = String(type).toLowerCase();
    if (known.has(key)) out.push(key);
    else {
      const group = EVENT_TYPE_GROUPS.find((entry) => entry.id === key);
      if (group) out.push(...group.types);
    }
  }
  return out.length ? [...new Set(out)] : null;
}

/**
 * Run one Indonesia tool.
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @param {{viewer: object, dataManager?: object, indonesia?: object, client?: object}} context
 * @returns {Promise<object|null>} Structured result, or null when the name is not an Indonesia tool.
 */
export async function runIndonesiaTool(name, args = {}, { viewer, indonesia = globalThis.window?.__godsEyeView?.indonesia || null, client = intelClient } = {}) {
  if (!INDONESIA_TOOL_NAMES.includes(name)) return null;
  const pack = await client.getPack().catch(() => null);
  const provinces = pack?.provinces || [];
  const province = args.province !== undefined && args.province !== null ? resolveProvince(args.province, provinces) : undefined;
  if (args.province && !province) return { ok: false, action: name, error: `Unknown province: ${args.province}`, provinces: provinces.map((entry) => `${entry.code} ${entry.name}`) };
  const scope = province ? `province:${province.code}` : 'indonesia';

  if (name === 'set_indonesia_mode') {
    if (!indonesia) return { ok: false, action: name, error: 'Indonesia command center is not initialized' };
    if (typeof args.enabled === 'boolean') await indonesia.setIndonesiaMode(args.enabled);
    if (args.province !== undefined) indonesia.state.set({ provinceCode: province ? province.code : null });
    if (args.openPanel || args.tab) indonesia.showTab(args.tab || 'alerts');
    const state = indonesia.state.get();
    return { ok: true, action: name, enabled: state.enabled, province: province ? { code: province.code, name: province.name } : null, mapMode: state.mapMode };
  }

  if (name === 'set_map_mode') {
    if (!indonesia) return { ok: false, action: name, error: 'GIS bridge is not initialized' };
    await indonesia.setMapMode(args.mode === 'gis' ? 'gis' : '3d');
    const mode = indonesia.getMapMode();
    return { ok: mode === (args.mode === 'gis' ? 'gis' : '3d'), action: name, mode };
  }

  if (name === 'get_indonesia_summary') {
    const brief = await client.getBrief({ scope, hours: args.hours });
    return {
      ok: true,
      action: name,
      scope: brief.scope,
      generatedAt: brief.generatedAt,
      windowHours: brief.windowHours,
      headline: brief.headline,
      highestSeverity: brief.highestSeverity,
      signalCount: brief.signalCount,
      alerts: brief.alerts,
      sections: brief.sections.map((section) => ({ type: section.type, label: section.label, count: section.count, highestSeverity: section.highestSeverity, lines: section.lines })),
      sources: brief.sources,
      stale: Boolean(brief.stale),
      note: 'Each line names its source and timestamp. Related signals are correlations, not confirmed causes.',
    };
  }

  if (name === 'query_events') {
    const payload = await client.getEvents({ scope, hours: args.hours || 72, types: typeList(args.types) || undefined, severity: args.minSeverity, limit: 500 });
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 12));
    const events = payload.events || [];
    const byType = {};
    for (const event of events) byType[event.type] = (byType[event.type] || 0) + 1;
    let flewTo = null;
    if (args.flyToFirst && events[0]?.location && indonesia) {
      indonesia.selectEvent(events[0], { fly: true });
      flewTo = events[0].id;
    }
    return {
      ok: true,
      action: name,
      scopeLabel: `${province ? province.name : 'Indonesia'} · last ${args.hours || 72} h${args.types?.length ? ` · ${args.types.join(', ')}` : ''}`,
      count: payload.count ?? events.length,
      byType,
      events: events.slice(0, limit).map(compactEvent),
      truncated: events.length > limit,
      stale: Boolean(payload.stale),
      flewTo,
    };
  }

  if (name === 'query_nearby_events') {
    let center = null;
    if (Number.isFinite(args.latitude) && Number.isFinite(args.longitude)) center = { name: 'given point', lat: args.latitude, lon: args.longitude };
    else if (args.place) center = resolvePlace(args.place, pack);
    else if (viewer) { const view = viewCenter(viewer); center = { name: 'view centre', lat: view.lat, lon: view.lon }; }
    if (!center) return { ok: false, action: name, error: `Unknown place: ${args.place}` };
    const payload = await client.getEvents({ hours: args.hours || 72, types: typeList(args.types) || undefined, limit: 2000 });
    const nearby = eventsWithinRadius(payload.events || [], center, args.radiusKm);
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 12));
    return {
      ok: true,
      action: name,
      center: { name: center.name, lat: center.lat, lon: center.lon },
      radiusKm: args.radiusKm,
      scopeLabel: `within ${args.radiusKm} km of ${center.name} · last ${args.hours || 72} h`,
      count: nearby.length,
      events: nearby.slice(0, limit).map(compactEvent),
      truncated: nearby.length > limit,
      stale: Boolean(payload.stale),
    };
  }

  if (name === 'get_data_source_status') {
    const status = await client.getStatus();
    return {
      ok: true,
      action: name,
      lastSweepAt: status.lastSweepAt,
      summary: status.summary,
      eventCount: status.eventCount,
      activeAlerts: status.activeAlerts,
      sources: (status.health || []).map((entry) => ({
        id: entry.id, name: entry.name, category: entry.category, state: entry.state.toUpperCase(), configured: entry.configured,
        needsKey: entry.configured ? null : entry.envKey, lastRunAt: entry.lastRunAt, everyMinutes: Math.round(entry.intervalMs / 60_000),
        events: entry.eventCount, error: entry.error, license: entry.license, attribution: entry.attribution,
      })),
      stale: Boolean(status.stale),
    };
  }

  if (name === 'set_timeline_range') {
    if (!indonesia) return { ok: false, action: name, error: 'Indonesia command center is not initialized' };
    const patch = {};
    if (Number.isFinite(args.hours)) patch.timelineHours = Math.max(1, Math.min(720, args.hours));
    indonesia.state.set({ ...patch, timelineUntilMs: null });
    if (typeof args.playing === 'boolean') indonesia.setTimelinePlaying?.(args.playing);
    const state = indonesia.state.get();
    return { ok: true, action: name, hours: state.timelineHours, playing: state.timelinePlaying };
  }

  if (name === 'measure_distance') {
    const from = resolvePlace(args.from, pack);
    const to = resolvePlace(args.to, pack);
    if (!from || !to) return { ok: false, action: name, error: `Unknown place: ${!from ? args.from : args.to}` };
    return {
      ok: true,
      action: name,
      from: { name: from.name, lat: from.lat, lon: from.lon, dms: toDms(from.lat, from.lon) },
      to: { name: to.name, lat: to.lat, lon: to.lon, dms: toDms(to.lat, to.lon) },
      distanceKm: Math.round(distanceKm(from, to) * 10) / 10,
      bearingDeg: Math.round(bearingDeg(from, to)),
    };
  }

  if (name === 'spatial_buffer') {
    let center = null;
    if (Number.isFinite(args.latitude) && Number.isFinite(args.longitude)) center = { name: 'given point', lat: args.latitude, lon: args.longitude };
    else if (args.place) center = resolvePlace(args.place, pack);
    else if (viewer) { const view = viewCenter(viewer); center = { name: 'view centre', lat: view.lat, lon: view.lon }; }
    if (!center) return { ok: false, action: name, error: `Unknown place: ${args.place}` };
    const ring = bufferKm(center, args.radiusKm);
    const payload = await client.getEvents({ hours: args.hours || 72, limit: 2000 });
    const inside = eventsWithinRadius(payload.events || [], center, args.radiusKm);
    const airports = (pack?.airports || []).map((airport) => makePoint([airport.lon, airport.lat], airport));
    const volcanoes = (pack?.volcanoes || []).map((volcano) => makePoint([volcano.lon, volcano.lat], volcano));
    const nearestAirport = nearestFeature(center, airports);
    const nearestVolcano = nearestFeature(center, volcanoes);
    const gisMap = indonesia?.getGisMap?.();
    if (gisMap?.isReady?.()) gisMap.setAnalysis({ type: 'FeatureCollection', features: [ring] });
    return {
      ok: true,
      action: name,
      center: { name: center.name, lat: center.lat, lon: center.lon },
      radiusKm: args.radiusKm,
      areaKm2: Math.round(areaKm2(ring)),
      eventCount: inside.length,
      events: inside.slice(0, 12).map(compactEvent),
      nearestAirport: nearestAirport ? { name: nearestAirport.feature.properties.name, ident: nearestAirport.feature.properties.ident, distanceKm: Math.round(nearestAirport.distanceKm * 10) / 10 } : null,
      nearestVolcano: nearestVolcano ? { name: nearestVolcano.feature.properties.name, distanceKm: Math.round(nearestVolcano.distanceKm * 10) / 10 } : null,
      drawnOnGis: Boolean(gisMap?.isReady?.()),
    };
  }

  return null;
}
