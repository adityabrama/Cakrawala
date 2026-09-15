/**
 * @module providers/reliefweb
 *
 * ReliefWeb (UN OCHA) ongoing disasters for Indonesia. Since November 2025
 * the API answers HTTP 410 unless the request carries a registered
 * `appname`, so this provider stays NOT CONFIGURED until `RELIEFWEB_APPNAME`
 * is set. Register at https://apidoc.reliefweb.int/parameters#appname
 */

import { defineProvider, fetchJson, toNumber } from './provider.js';

export const RELIEFWEB_URL = 'https://api.reliefweb.int/v1/disasters';

/** Parse a ReliefWeb disasters payload into event fields. */
export function parseReliefwebDisasters(payload) {
  const events = [];
  for (const row of Array.isArray(payload?.data) ? payload.data : []) {
    const fields = row?.fields || {};
    const created = fields.date?.created || fields.date?.event;
    if (!fields.name || !created) continue;
    const primary = fields.primary_country || {};
    const lat = toNumber(primary.location?.lat);
    const lon = toNumber(primary.location?.lon);
    events.push({
      id: `reliefweb:${row.id}`,
      type: 'disaster',
      subtype: String(fields.primary_type?.name || fields.type?.[0]?.name || 'disaster').toLowerCase().replace(/\s+/g, '-'),
      timestamp: created,
      location: lat !== null && lon !== null ? { lat, lon } : null,
      title: String(fields.name),
      description: `Status: ${fields.status || 'unknown'}${fields.glide ? ` · GLIDE ${fields.glide}` : ''}`,
      severity: fields.status === 'ongoing' ? 'medium' : 'low',
      confidence: 0.8,
      status: fields.status === 'ongoing' ? 'delayed' : 'historical',
      country: 'ID',
      sourceUrl: fields.url_alias ? `https://reliefweb.int${fields.url_alias}` : (fields.url || null),
      raw: { status: fields.status || null, glide: fields.glide || null, types: (fields.type || []).map((type) => type.name) },
    });
  }
  return events;
}

export const reliefwebProvider = defineProvider({
  id: 'reliefweb-indonesia',
  name: 'ReliefWeb disasters (Indonesia)',
  category: 'disaster',
  region: 'ID',
  auth: 'free-key',
  envKey: 'RELIEFWEB_APPNAME',
  intervalMs: 60 * 60_000,
  attribution: 'ReliefWeb (UN OCHA)',
  license: 'ReliefWeb API terms; registered appname required',
  sourceUrl: 'https://reliefweb.int/disasters',
  async fetch({ fetchImpl, signal, env }) {
    const params = new URLSearchParams({
      appname: env.RELIEFWEB_APPNAME,
      'filter[field]': 'country.iso3',
      'filter[value]': 'IDN',
      limit: '30',
      'fields[include][]': 'name',
      sort: 'date.created:desc',
    });
    for (const field of ['date', 'status', 'glide', 'primary_type', 'type', 'url_alias', 'primary_country']) params.append('fields[include][]', field);
    const payload = await fetchJson(`${RELIEFWEB_URL}?${params}`, { fetchImpl, signal, retries: 0 });
    const events = parseReliefwebDisasters(payload);
    return {
      events,
      metrics: { reliefweb_ongoing: { value: events.filter((event) => event.raw.status === 'ongoing').length, kind: 'count', threshold: 1, label: 'ReliefWeb ongoing disasters (Indonesia)', source: 'reliefweb-indonesia' } },
      meta: { total: payload?.totalCount ?? null },
    };
  },
});

export default reliefwebProvider;
