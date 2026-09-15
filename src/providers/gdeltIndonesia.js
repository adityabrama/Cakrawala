/**
 * @module providers/gdeltIndonesia
 *
 * GDELT DOC 2.0 article list for Indonesia. Metadata and links only (no
 * article bodies). GDELT allows one request every 5 seconds; this adapter
 * makes one request per sweep and never runs more often than every 15 min.
 * Locations are estimated by matching province and city names in headlines,
 * so news events carry `raw.locationMethod = 'name-match'` and low confidence.
 */

import { defineProvider, fetchJson, shortHash } from './provider.js';

export const GDELT_DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const GDELT_MIN_INTERVAL_MS = 5_500;

let lastRequestAt = 0;

const TOPIC_RULES = Object.freeze([
  [/banjir|flood/i, 'flood'],
  [/gempa|earthquake|quake/i, 'earthquake'],
  [/tsunami/i, 'tsunami'],
  [/erupsi|gunung|volcan|letusan/i, 'volcano'],
  [/kebakaran|karhutla|wildfire|fire/i, 'fire'],
  [/longsor|landslide/i, 'landslide'],
  [/cuaca|hujan|badai|angin|weather|storm|cyclone/i, 'weather'],
  [/kabut asap|haze|smog/i, 'haze'],
  [/kekeringan|drought/i, 'drought'],
  [/bandara|airport|penerbangan|flight|pesawat|aircraft/i, 'aviation'],
  [/pelabuhan|port|kapal|vessel|ship|ferry|maritime/i, 'maritime'],
  [/tol|macet|traffic|kereta|train|railway|jalan/i, 'transport'],
  [/inflasi|rupiah|ekonomi|economy|gdp|export|impor|tarif/i, 'economy'],
  [/wabah|outbreak|dengue|malaria|health|kesehatan/i, 'health'],
]);

/** Topic subtype for a headline; 'general' when nothing matches. */
export function classifyHeadline(title) {
  for (const [pattern, topic] of TOPIC_RULES) {
    if (pattern.test(String(title || ''))) return topic;
  }
  return 'general';
}

/** GDELT's compact "YYYYMMDDTHHMMSSZ" → ISO, or null. */
export function parseGdeltDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value || '').trim());
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

/** Normalize one GDELT article into event fields; null when it has no usable url/title/date. */
export function parseGdeltArticle(article, pack = null) {
  let url = null;
  try {
    const parsed = new URL(String(article?.url || ''));
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
  } catch { /* invalid url */ }
  const title = String(article?.title || '').replace(/\s+/g, ' ').trim();
  const timestamp = parseGdeltDate(article?.seendate);
  if (!url || !title || !timestamp) return null;
  const place = pack?.matchPlaceInText ? pack.matchPlaceInText(title) : null;
  const topic = classifyHeadline(title);
  return {
    id: `gdelt:${shortHash(url)}`,
    type: 'news',
    subtype: topic,
    timestamp,
    location: place ? { lat: place.lat, lon: place.lon } : null,
    title,
    description: `${article.domain || new URL(url).hostname} · ${article.language || ''} · ${article.sourcecountry || ''}`.replace(/\s+·\s*$/, ''),
    severity: 'info',
    confidence: place ? 0.35 : 0.3,
    status: 'live',
    country: 'ID',
    province: place?.province || null,
    provinceCode: place?.provinceCode || null,
    city: place?.city || null,
    sourceUrl: url,
    raw: {
      domain: article.domain || null,
      language: article.language || null,
      sourceCountry: article.sourcecountry || null,
      locationMethod: place ? 'name-match' : 'none',
      matchedPlace: place?.name || null,
      topic,
    },
  };
}

export const gdeltIndonesiaProvider = defineProvider({
  id: 'gdelt-indonesia',
  name: 'GDELT news (Indonesia)',
  category: 'news',
  region: 'ID',
  auth: 'keyless',
  intervalMs: 15 * 60_000,
  retentionMs: 7 * 24 * 60 * 60_000,
  maxEvents: 1500,
  attribution: 'News metadata: The GDELT Project (gdeltproject.org)',
  license: 'GDELT terms of use; metadata and links only',
  sourceUrl: 'https://www.gdeltproject.org/',
  async fetch({ fetchImpl, signal, pack, now = Date.now }) {
    const wait = GDELT_MIN_INTERVAL_MS - (now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = now();
    const params = new URLSearchParams({
      query: 'Indonesia sourcecountry:ID',
      mode: 'ArtList',
      maxrecords: '75',
      timespan: '24h',
      format: 'json',
      sort: 'DateDesc',
    });
    // One retry after the mandatory 5 s gap: this host is flaky on some
    // networks, and the next scheduled run is 15 minutes away.
    const payload = await fetchJson(`${GDELT_DOC_URL}?${params}`, { fetchImpl, signal, retries: 1, retryDelayMs: GDELT_MIN_INTERVAL_MS });
    const events = [];
    const seen = new Set();
    for (const article of Array.isArray(payload?.articles) ? payload.articles : []) {
      const event = parseGdeltArticle(article, pack);
      if (!event) continue;
      const signature = event.title.toLowerCase();
      if (seen.has(signature)) continue;
      seen.add(signature);
      events.push(event);
    }
    const located = events.filter((event) => event.location).length;
    return {
      events,
      metrics: {
        gdelt_articles_24h: { value: events.length, kind: 'count', threshold: 15, label: 'Indonesia news articles (24 h)', source: 'gdelt-indonesia' },
      },
      meta: { located, unlocated: events.length - located },
    };
  },
});

export default gdeltIndonesiaProvider;
