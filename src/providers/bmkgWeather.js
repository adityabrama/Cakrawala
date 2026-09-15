/**
 * @module providers/bmkgWeather
 *
 * BMKG public weather forecast API (3 days, 3-hourly) for a bundled list of
 * city points (`src/data/indonesia/weatherPoints.json`, one kelurahan code
 * per city). Official and keyless. Forecasts are `modeled` by definition;
 * severe conditions raise low/medium events so the Alert Center can show
 * them, and every point's current slot is published in `meta.forecasts`.
 *
 * Source: https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=<code>
 */

import { defineProvider, fetchJson, sleep, toNumber } from './provider.js';

export const BMKG_WEATHER_URL = 'https://api.bmkg.go.id/publik/prakiraan-cuaca';

/** BMKG weather codes that count as severe, with a short label. */
export const SEVERE_WEATHER_CODES = Object.freeze({
  63: { label: 'Heavy rain', severity: 'medium' },
  95: { label: 'Thunderstorm', severity: 'medium' },
  97: { label: 'Severe thunderstorm', severity: 'high' },
  61: { label: 'Rain', severity: 'low' },
  80: { label: 'Local rain', severity: 'low' },
  10: { label: 'Smoke', severity: 'low' },
  5: { label: 'Haze', severity: 'low' },
});

/** Flatten BMKG's day → slot arrays and pick the slot closest to `nowMs`. */
export function pickForecastSlots(payload, nowMs = Date.now()) {
  const days = payload?.data?.[0]?.cuaca;
  const slots = (Array.isArray(days) ? days.flat() : [])
    .map((slot) => ({ ...slot, ms: Date.parse(slot?.datetime || slot?.utc_datetime?.replace(' ', 'T') + 'Z' || '') }))
    .filter((slot) => Number.isFinite(slot.ms))
    .sort((a, b) => a.ms - b.ms);
  if (!slots.length) return { current: null, next24h: [] };
  let current = slots[0];
  for (const slot of slots) {
    if (Math.abs(slot.ms - nowMs) < Math.abs(current.ms - nowMs)) current = slot;
  }
  const next24h = slots.filter((slot) => slot.ms >= nowMs - 3_600_000 && slot.ms <= nowMs + 24 * 3_600_000);
  return { current, next24h };
}

function compactSlot(slot) {
  return {
    at: new Date(slot.ms).toISOString(),
    code: toNumber(slot.weather),
    condition: slot.weather_desc_en || slot.weather_desc || null,
    conditionId: slot.weather_desc || null,
    tempC: toNumber(slot.t),
    humidityPct: toNumber(slot.hu),
    windKmh: toNumber(slot.ws),
    windDir: slot.wd || null,
    cloudPct: toNumber(slot.tcc),
    precipMm: toNumber(slot.tp),
    visibilityM: toNumber(slot.vs),
  };
}

/** Build the per-point forecast record and the optional severe-weather event. */
export function buildWeatherPoint(point, payload, { nowMs = Date.now() } = {}) {
  const { current, next24h } = pickForecastSlots(payload, nowMs);
  if (!current) return null;
  const lokasi = payload?.lokasi || {};
  const severe = next24h.map((slot) => SEVERE_WEATHER_CODES[toNumber(slot.weather)]).filter(Boolean)
    .sort((a, b) => ['low', 'medium', 'high'].indexOf(b.severity) - ['low', 'medium', 'high'].indexOf(a.severity))[0] || null;
  const forecast = {
    id: point.id,
    name: point.name,
    provinceCode: point.provinceCode,
    province: lokasi.provinsi || point.province || null,
    regency: lokasi.kotkab || null,
    adm4: point.adm4,
    lat: toNumber(lokasi.lat) ?? point.lat,
    lon: toNumber(lokasi.lon) ?? point.lon,
    analysisDate: current.analysis_date || null,
    current: compactSlot(current),
    next24h: next24h.map(compactSlot),
    severe: severe ? severe.label : null,
    status: 'modeled',
    source: 'bmkg-weather',
  };
  const event = {
    id: `bmkg-weather:${point.id}`,
    type: 'weather',
    subtype: 'forecast',
    timestamp: forecast.current.at,
    location: { lat: forecast.lat, lon: forecast.lon },
    title: `${point.name}: ${forecast.current.condition || 'forecast'}${Number.isFinite(forecast.current.tempC) ? ` ${forecast.current.tempC}°C` : ''}${severe ? ` · ${severe.label} expected` : ''}`,
    description: severe ? `${severe.label} forecast within 24 h (BMKG)` : 'BMKG 3-hourly forecast',
    severity: severe ? severe.severity : 'info',
    confidence: 0.7,
    status: 'modeled',
    country: 'ID',
    province: forecast.province,
    provinceCode: point.provinceCode,
    city: point.name,
    sourceUrl: `${BMKG_WEATHER_URL}?adm4=${point.adm4}`,
    raw: { severe: severe ? severe.label : null, current: forecast.current, adm4: point.adm4 },
  };
  return { forecast, event };
}

export const bmkgWeatherProvider = defineProvider({
  id: 'bmkg-weather',
  name: 'BMKG Prakiraan Cuaca',
  category: 'weather',
  region: 'ID',
  auth: 'keyless',
  intervalMs: 60 * 60_000,
  retentionMs: 4 * 60 * 60_000,
  attribution: 'Prakiraan cuaca: BMKG (api.bmkg.go.id)',
  license: 'Public API of BMKG; attribution required',
  sourceUrl: 'https://data.bmkg.go.id/prakiraan-cuaca/',
  async fetch({ fetchImpl, signal, pack, now = Date.now, log }) {
    const points = Array.isArray(pack?.weatherPoints) ? pack.weatherPoints : [];
    if (!points.length) throw new Error('No BMKG weather points bundled');
    const events = [];
    const forecasts = {};
    const failures = [];
    for (const point of points) {
      try {
        const payload = await fetchJson(`${BMKG_WEATHER_URL}?adm4=${encodeURIComponent(point.adm4)}`, { fetchImpl, signal, retries: 0 });
        const built = buildWeatherPoint(point, payload, { nowMs: now() });
        if (!built) { failures.push(`${point.id}: empty forecast`); continue; }
        forecasts[point.id] = built.forecast;
        events.push(built.event);
      } catch (error) {
        failures.push(`${point.id}: ${error.message}`);
      }
      await sleep(150, signal).catch(() => {});
    }
    if (!events.length) throw new Error(failures.join('; ') || 'BMKG weather returned nothing');
    if (failures.length) log?.warn?.(`[bmkg-weather] ${failures.length} point(s) failed: ${failures.slice(0, 3).join('; ')}`);
    const severeCount = events.filter((event) => event.raw.severe).length;
    return {
      events,
      metrics: {
        bmkg_severe_points: { value: severeCount, kind: 'count', threshold: 2, label: 'Cities with severe weather forecast (24 h)', source: 'bmkg-weather' },
      },
      meta: { forecasts, points: points.length, failures },
    };
  },
});

export default bmkgWeatherProvider;
