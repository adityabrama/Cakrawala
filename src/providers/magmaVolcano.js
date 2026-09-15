/**
 * @module providers/magmaVolcano
 *
 * PVMBG / MAGMA Indonesia activity levels for every monitored volcano. MAGMA
 * publishes the current levels as a public HTML table (no JSON endpoint at
 * audit time, 2026-09-15), so this adapter parses that page and labels the
 * result `web-table`. Positions come from the bundled Wikidata snapshot
 * (`src/data/indonesia/volcanoes.json`, CC0).
 *
 * Source: https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas
 */

import { attachAdministrative, defineProvider, fetchText, nameKey } from './provider.js';

export const MAGMA_LEVELS_URL = 'https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas';

const LEVEL_SEVERITY = Object.freeze({ 4: 'critical', 3: 'high', 2: 'medium', 1: 'info' });
const LEVEL_LABEL = Object.freeze({ 4: 'Level IV (Awas)', 3: 'Level III (Siaga)', 2: 'Level II (Waspada)', 1: 'Level I (Normal)' });

function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/**
 * Parse the MAGMA activity table into { name, province, level, reportUrl }.
 * Level header rows contain "Level N (…)"; the volcano rows that follow belong
 * to that level until the next header.
 */
export function parseMagmaLevels(html) {
  const table = (String(html).match(/<table[\s\S]*?<\/table>/i) || [''])[0];
  const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
  const volcanoes = [];
  let level = null;
  for (const row of rows) {
    const text = stripTags(row);
    const header = text.match(/Level\s+(IV|III|II|I)\b/);
    if (header && /rowspan|Hasil pengamatan|Tidak ada gunung/i.test(row)) {
      level = { IV: 4, III: 3, II: 2, I: 1 }[header[1]];
      continue;
    }
    if (!level) continue;
    const name = text.replace(/Lihat laporan.*$/i, '').trim();
    const split = name.match(/^(.+?)\s+-\s+(.+)$/);
    if (!split) continue;
    const reportUrl = (row.match(/href="(https:\/\/magma\.esdm\.go\.id\/v1\/gunung-api\/laporan\/[^"]+)"/) || [])[1] || null;
    volcanoes.push({ name: split[1].trim(), province: split[2].trim(), level, reportUrl: reportUrl ? reportUrl.replace(/&amp;/g, '&') : null });
  }
  return volcanoes;
}

const NAME_ALIASES = Object.freeze({
  'tangkuban parahu': 'tangkuban perahu',
  'arjuno welirang': 'arjuno welirang',
  'ili lewotolok': 'lewotolok',
  'ile werung': 'iliwerung',
  'lewotobi laki laki': 'lewotobi laki laki',
  'anak ranakah': 'ranakah',
  'peut sague': 'peuet sague',
  'sangeangapi': 'sangeang api',
  'kie besi': 'kiebesi',
  'sorikmarapi': 'sorik marapi',
});

/** Find the bundled volcano record for a MAGMA name (exact key, alias, then token overlap). */
export function matchVolcano(name, volcanoes = []) {
  const key = nameKey(name);
  const alias = NAME_ALIASES[key] || key;
  const exact = volcanoes.find((volcano) => volcano.key === key || volcano.key === alias || (volcano.aliases || []).includes(key));
  if (exact) return exact;
  const tokens = alias.split(' ').filter((token) => token.length > 2);
  let best = null;
  let bestScore = 0;
  for (const volcano of volcanoes) {
    const candidateTokens = new Set(volcano.key.split(' '));
    const score = tokens.filter((token) => candidateTokens.has(token)).length;
    if (score > bestScore) { best = volcano; bestScore = score; }
  }
  return bestScore > 0 && bestScore >= Math.ceil(tokens.length / 2) ? best : null;
}

export const magmaVolcanoProvider = defineProvider({
  id: 'magma-volcano',
  name: 'PVMBG MAGMA gunung api',
  category: 'volcano',
  region: 'ID',
  auth: 'keyless',
  intervalMs: 30 * 60_000,
  retentionMs: 2 * 60 * 60_000,
  attribution: 'Tingkat aktivitas gunung api: PVMBG / MAGMA Indonesia (Badan Geologi)',
  license: 'Public information of Badan Geologi; parsed from the public web table',
  sourceUrl: MAGMA_LEVELS_URL,
  async fetch({ fetchImpl, signal, pack, now = Date.now }) {
    const { text } = await fetchText(MAGMA_LEVELS_URL, { fetchImpl, signal, headers: { Accept: 'text/html' } });
    const rows = parseMagmaLevels(text);
    if (!rows.length) throw new Error('MAGMA activity table not found in page');
    const observedAt = new Date(now()).toISOString();
    const events = [];
    const counts = { 4: 0, 3: 0, 2: 0, 1: 0 };
    let unplaced = 0;
    for (const row of rows) {
      counts[row.level] += 1;
      const volcano = matchVolcano(row.name, pack?.volcanoes || []);
      if (!volcano) unplaced += 1;
      const event = {
        id: `magma:${nameKey(row.name).replace(/\s+/g, '-')}`,
        type: 'volcano',
        subtype: 'activity-level',
        timestamp: observedAt,
        location: volcano ? { lat: volcano.lat, lon: volcano.lon } : null,
        title: `${row.name} · ${LEVEL_LABEL[row.level]}`,
        description: `PVMBG activity status ${LEVEL_LABEL[row.level]} — ${row.province}`,
        severity: LEVEL_SEVERITY[row.level],
        confidence: volcano ? 0.9 : 0.6,
        status: 'live',
        country: 'ID',
        province: row.province,
        sourceUrl: row.reportUrl || MAGMA_LEVELS_URL,
        raw: { alertLevel: row.level, levelLabel: LEVEL_LABEL[row.level], method: 'web-table', reportUrl: row.reportUrl, elevationM: volcano?.elevationM ?? null, wikidata: volcano?.id ?? null, observedAt },
      };
      attachAdministrative(event, pack, row.province);
      events.push(event);
    }
    return {
      events,
      metrics: {
        magma_level_4: { value: counts[4], kind: 'count', threshold: 1, label: 'Volcanoes at Level IV (Awas)', source: 'magma-volcano' },
        magma_level_3: { value: counts[3], kind: 'count', threshold: 1, label: 'Volcanoes at Level III (Siaga)', source: 'magma-volcano' },
        magma_level_2: { value: counts[2], kind: 'count', threshold: 1, label: 'Volcanoes at Level II (Waspada)', source: 'magma-volcano' },
      },
      meta: { monitored: rows.length, unplaced },
    };
  },
});

export default magmaVolcanoProvider;
