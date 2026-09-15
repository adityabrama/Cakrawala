/**
 * @module providers/worldBank
 *
 * World Bank Indicators API for Indonesia: GDP, inflation, unemployment,
 * population, poverty. Keyless, CC BY 4.0, annual data — published as
 * metrics and a small time series for the economy panel (no map events).
 */

import { defineProvider, fetchJson, sleep, toNumber } from './provider.js';

export const WORLD_BANK_INDICATORS = Object.freeze([
  { code: 'NY.GDP.MKTP.CD', key: 'gdp_usd', label: 'GDP (current US$)', unit: 'USD' },
  { code: 'NY.GDP.MKTP.KD.ZG', key: 'gdp_growth_pct', label: 'GDP growth', unit: '%' },
  { code: 'FP.CPI.TOTL.ZG', key: 'inflation_pct', label: 'Inflation (CPI)', unit: '%' },
  { code: 'SL.UEM.TOTL.ZS', key: 'unemployment_pct', label: 'Unemployment', unit: '%' },
  { code: 'SP.POP.TOTL', key: 'population', label: 'Population', unit: 'people' },
  { code: 'SI.POV.NAHC', key: 'poverty_pct', label: 'Poverty headcount (national line)', unit: '%' },
]);

/** Parse a World Bank indicator payload into { latest, series }. */
export function parseWorldBankSeries(payload) {
  const rows = Array.isArray(payload?.[1]) ? payload[1] : [];
  const series = rows
    .map((row) => ({ year: Number(row?.date), value: toNumber(row?.value) }))
    .filter((row) => Number.isFinite(row.year) && row.value !== null)
    .sort((a, b) => a.year - b.year);
  return { latest: series.at(-1) || null, series };
}

export const worldBankProvider = defineProvider({
  id: 'world-bank-indonesia',
  name: 'World Bank indicators (Indonesia)',
  category: 'economy',
  region: 'ID',
  auth: 'keyless',
  intervalMs: 24 * 60 * 60_000,
  attribution: 'Economic indicators: World Bank Open Data (CC BY 4.0)',
  license: 'CC BY 4.0',
  sourceUrl: 'https://data.worldbank.org/country/indonesia',
  async fetch({ fetchImpl, signal }) {
    const metrics = {};
    const indicators = {};
    const failures = [];
    for (const indicator of WORLD_BANK_INDICATORS) {
      try {
        const payload = await fetchJson(`https://api.worldbank.org/v2/country/IDN/indicator/${indicator.code}?format=json&mrv=8`, { fetchImpl, signal });
        const { latest, series } = parseWorldBankSeries(payload);
        indicators[indicator.key] = { ...indicator, latest, series, status: 'historical' };
        if (latest) {
          metrics[`wb_${indicator.key}`] = { value: latest.value, kind: 'numeric', threshold: 1000, label: `${indicator.label} (${latest.year})`, unit: indicator.unit, source: 'world-bank-indonesia' };
        }
      } catch (error) {
        failures.push(`${indicator.code}: ${error.message}`);
      }
      await sleep(100, signal).catch(() => {});
    }
    if (!Object.keys(indicators).length) throw new Error(failures.join('; '));
    return { events: [], metrics, meta: { indicators, failures } };
  },
});

export default worldBankProvider;
