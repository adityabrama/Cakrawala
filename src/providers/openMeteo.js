/**
 * @module providers/openMeteo
 *
 * On-demand weather and air quality for any coordinate (map click, province
 * capital, city preset) from Open-Meteo. Keyless, CC BY 4.0. Both are model
 * outputs (forecast model / CAMS), so records are labelled `modeled`.
 */

import { defineProvider, fetchJson, toNumber } from './provider.js';

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

/** WMO weather interpretation codes → label. */
export const WMO_CODES = Object.freeze({
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 61: 'Slight rain', 63: 'Rain', 65: 'Heavy rain',
  80: 'Rain showers', 81: 'Moderate showers', 82: 'Violent showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
});

function pinUtc(value) {
  const text = String(value || '');
  return /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(text) ? text : `${text}Z`;
}

/** Normalize an Open-Meteo forecast payload (current + hourly next 24 h). */
export function normalizeOpenMeteoWeather(payload) {
  const current = payload?.current;
  if (!current || !Number.isFinite(Number(current.temperature_2m))) return null;
  const hourly = payload?.hourly;
  const times = Array.isArray(hourly?.time) ? hourly.time : [];
  const next24h = times.slice(0, 24).map((time, index) => ({
    at: new Date(pinUtc(time)).toISOString(),
    tempC: toNumber(hourly.temperature_2m?.[index]),
    precipMm: toNumber(hourly.precipitation?.[index]),
    windKmh: toNumber(hourly.wind_speed_10m?.[index]),
    code: toNumber(hourly.weather_code?.[index]),
    condition: WMO_CODES[toNumber(hourly.weather_code?.[index])] || null,
  }));
  const code = toNumber(current.weather_code);
  return {
    observedAt: new Date(pinUtc(current.time)).toISOString(),
    lat: toNumber(payload.latitude),
    lon: toNumber(payload.longitude),
    current: {
      tempC: toNumber(current.temperature_2m),
      humidityPct: toNumber(current.relative_humidity_2m),
      precipMm: toNumber(current.precipitation),
      windKmh: toNumber(current.wind_speed_10m),
      windDirDeg: toNumber(current.wind_direction_10m),
      code,
      condition: WMO_CODES[code] || null,
    },
    next24h,
    status: 'modeled',
    source: 'open-meteo',
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  };
}

/** Normalize an Open-Meteo air-quality payload. */
export function normalizeOpenMeteoAir(payload) {
  const current = payload?.current;
  if (!current) return null;
  return {
    observedAt: new Date(pinUtc(current.time)).toISOString(),
    pm25: toNumber(current.pm2_5),
    pm10: toNumber(current.pm10),
    usAqi: toNumber(current.us_aqi),
    status: 'modeled',
    source: 'open-meteo-cams',
    attribution: 'Air quality: Open-Meteo / CAMS (CC BY 4.0), modeled',
  };
}

export const openMeteoProvider = defineProvider({
  id: 'open-meteo',
  name: 'Open-Meteo weather & air quality',
  category: 'weather',
  region: 'GLOBAL',
  auth: 'keyless',
  onDemand: true,
  intervalMs: 0,
  attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  license: 'CC BY 4.0',
  sourceUrl: 'https://open-meteo.com/',
  async fetch() {
    return { events: [], metrics: {}, meta: { onDemand: true } };
  },
  /** Query weather (and optionally air quality) for one point. */
  async query({ lat, lon, air = true, fetchImpl = fetch, signal }) {
    const weatherParams = new URLSearchParams({
      latitude: String(lat), longitude: String(lon), timezone: 'UTC',
      current: 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,weather_code',
      hourly: 'temperature_2m,precipitation,wind_speed_10m,weather_code',
      forecast_days: '2',
    });
    const weather = normalizeOpenMeteoWeather(await fetchJson(`${OPEN_METEO_FORECAST_URL}?${weatherParams}`, { fetchImpl, signal }));
    let airQuality = null;
    if (air) {
      try {
        const airParams = new URLSearchParams({ latitude: String(lat), longitude: String(lon), current: 'pm2_5,pm10,us_aqi', timezone: 'UTC' });
        airQuality = normalizeOpenMeteoAir(await fetchJson(`${OPEN_METEO_AIR_URL}?${airParams}`, { fetchImpl, signal, retries: 0 }));
      } catch {
        airQuality = null;
      }
    }
    return { weather, airQuality };
  },
});

export default openMeteoProvider;
