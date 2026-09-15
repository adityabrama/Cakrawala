/**
 * @module providers/frankfurter
 *
 * Daily ECB reference rates via Frankfurter: IDR per USD, EUR, SGD, JPY,
 * CNY. Keyless. Reference rates are published once per working day, so the
 * record is `delayed`, never "live".
 */

import { defineProvider, fetchJson, toNumber } from './provider.js';

export const FRANKFURTER_URL = 'https://api.frankfurter.app/latest';
export const IDR_BASES = Object.freeze(['USD', 'EUR', 'SGD', 'JPY', 'CNY']);

/** Parse a Frankfurter payload for one base into { base, date, idr }. */
export function parseFrankfurter(payload) {
  const idr = toNumber(payload?.rates?.IDR);
  const date = typeof payload?.date === 'string' ? payload.date : null;
  const base = typeof payload?.base === 'string' ? payload.base : null;
  if (idr === null || !date || !base) return null;
  return { base, date, idr };
}

export const frankfurterProvider = defineProvider({
  id: 'frankfurter-idr',
  name: 'IDR reference rates (ECB)',
  category: 'economy',
  region: 'ID',
  auth: 'keyless',
  intervalMs: 6 * 60 * 60_000,
  attribution: 'Exchange rates: Frankfurter (frankfurter.app) — ECB reference rates',
  license: 'Free; ECB reference rates',
  sourceUrl: 'https://www.frankfurter.app/',
  async fetch({ fetchImpl, signal }) {
    const rates = {};
    const metrics = {};
    for (const base of IDR_BASES) {
      const payload = await fetchJson(`${FRANKFURTER_URL}?from=${base}&to=IDR`, { fetchImpl, signal, retries: 0 });
      const parsed = parseFrankfurter(payload);
      if (!parsed) continue;
      rates[base] = parsed;
      metrics[`idr_per_${base.toLowerCase()}`] = { value: parsed.idr, kind: 'numeric', threshold: 2, label: `IDR per ${base} (${parsed.date})`, unit: 'IDR', source: 'frankfurter-idr' };
    }
    if (!Object.keys(rates).length) throw new Error('Frankfurter returned no IDR rates');
    return { events: [], metrics, meta: { rates, status: 'delayed' } };
  },
});

export default frankfurterProvider;
