/**
 * @module providers/indonesiaNews
 *
 * Indonesian news from the RSS feeds of the national news agency, the Cabinet
 * Secretariat and major national outlets. It is the primary news source for
 * the Indonesia command center; GDELT stays as a secondary one.
 *
 * Why feeds instead of one aggregator: a single upstream (GDELT) throttles to
 * one request per 5 s and answers HTTP 429 often enough to leave the news tab
 * empty for long stretches. Here every feed is fetched independently with its
 * own timeout, a feed that fails serves its last good items, and the provider
 * only reports an error when no feed produced anything at all. Feeds that send
 * ETag / Last-Modified are polled conditionally, so an unchanged feed costs a
 * 304 and no parsing.
 *
 * Only headline, link, outlet and publication time are kept — never the
 * description or article body. Locations are estimated by matching province
 * and city names in the headline (`raw.locationMethod = 'name-match'`), exactly
 * like the GDELT adapter.
 */

import { defineProvider, shortHash, sleep, USER_AGENT } from './provider.js';
import { classifyHeadline } from './gdeltIndonesia.js';

/**
 * Feeds verified 2026-09-16 from an Indonesian network: every one answered 200
 * with dated items, the newest under ~20 minutes old (Setkab publishes a few
 * items a day). Order matters — when two feeds carry the same link or the same
 * headline, the earlier feed's copy is kept.
 */
export const NEWS_FEEDS = Object.freeze([
  { id: 'antara', outlet: 'ANTARA', url: 'https://www.antaranews.com/rss/terkini.xml' },
  { id: 'setkab', outlet: 'Sekretariat Kabinet RI', url: 'https://setkab.go.id/feed/' },
  { id: 'detik', outlet: 'detikNews', url: 'https://news.detik.com/rss' },
  { id: 'cnnindonesia', outlet: 'CNN Indonesia', url: 'https://www.cnnindonesia.com/nasional/rss' },
  { id: 'cnbcindonesia', outlet: 'CNBC Indonesia', url: 'https://www.cnbcindonesia.com/news/rss' },
  { id: 'liputan6', outlet: 'Liputan6', url: 'https://feed.liputan6.com/rss/news' },
  { id: 'okezone', outlet: 'Okezone', url: 'https://sindikasi.okezone.com/index.php/rss/1/RSS2.0' },
  { id: 'jpnn', outlet: 'JPNN', url: 'https://www.jpnn.com/index.php?mib=rss' },
  { id: 'republika', outlet: 'Republika', url: 'https://www.republika.co.id/rss' },
  { id: 'bbc-indonesia', outlet: 'BBC News Indonesia', url: 'https://feeds.bbci.co.uk/indonesia/rss.xml' },
  { id: 'sindonews', outlet: 'SINDOnews', url: 'https://www.sindonews.com/feed' },
  { id: 'mediaindonesia', outlet: 'Media Indonesia', url: 'https://mediaindonesia.com/feed' },
]);

export const NEWS_WINDOW_MS = 72 * 3_600_000;
const FUTURE_TOLERANCE_MS = 2 * 3_600_000;
// Every feed answered within ~6 s when verified; 10 s leaves room on a slow link.
const FEED_TIMEOUT_MS = 10_000;
const FEED_MAX_BYTES = 4 * 1024 * 1024;
const FEED_ATTEMPTS = 2;
const DEFAULT_FEED_RETRY_DELAY_MS = 1_500;
/**
 * Wall-clock budget for one sweep of all feeds. The engine abandons a provider
 * after 30 s (sweep.js DEFAULT_PROVIDER_TIMEOUT_MS) and then discards every
 * result, so the feeds must finish — retries included — comfortably before
 * that. A feed still out of time simply reports an error or its cached rows.
 */
export const NEWS_SWEEP_BUDGET_MS = 24_000;
/** A retry is only worth starting with at least this much budget left. */
const MIN_ATTEMPT_MS = 3_000;

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
});

/** Decode the HTML entities feeds put in titles and links. */
export function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Markup-looking tags only, so a literal "a < b" in a headline survives. */
const TAG_LIKE = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi;

/**
 * Text content of one element: CDATA unwrapped, tags stripped, entities
 * decoded, whitespace collapsed. Tags are stripped a second time after
 * decoding because some feeds entity-encode inline markup inside titles
 * (`Houthi Serang &lt;i&gt;Red Line&lt;/i&gt;`).
 */
function elementText(raw) {
  let text = String(raw || '');
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text).replace(TAG_LIKE, '');
  return text.replace(/\s+/g, ' ').trim();
}

/** Inner markup of the first `<name>` element in a block ('' when absent). Prefixed names (media:title) never match. */
function firstElement(block, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return match ? match[1] : '';
}

function httpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * Article link of one item. RSS `<link>` first; several Indonesian feeds (detik,
 * CNN Indonesia) omit it and publish the URL as `<guid>`; Atom uses
 * `<link href>`, where the article is the `alternate` (or rel-less) link — never
 * `self`, `enclosure` or `edit`.
 */
function itemLink(block) {
  const rss = httpUrl(elementText(firstElement(block, 'link')));
  if (rss) return rss;
  for (const [tag] of block.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (/\brel\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    if (rel && rel.toLowerCase() !== 'alternate') continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    const url = href ? httpUrl(decodeEntities(href[1])) : '';
    if (url) return url;
  }
  return httpUrl(elementText(firstElement(block, 'guid')));
}

/** "2026-09-16 15:44:10" style: a date and time with no zone at all. */
const ZONELESS_DATE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/;

/**
 * Parse a feed date. Every configured feed sends RFC 822 dates with a zone
 * today; a zone-less "YYYY-MM-DD HH:MM[:SS]" is read as WIB (UTC+7), which is
 * what Indonesian outlets publish in, instead of as the server's local time.
 */
export function parseFeedDate(text) {
  const value = String(text || '').trim();
  const zoneless = ZONELESS_DATE.exec(value);
  if (zoneless) return Date.parse(`${zoneless[1]}T${zoneless[2].length === 5 ? `${zoneless[2]}:00` : zoneless[2]}+07:00`);
  return Date.parse(value);
}

function itemBlocks(xml) {
  const text = String(xml || '');
  const isRss = /<item[\s>]/i.test(text);
  const pattern = isRss ? /<item[\s>][\s\S]*?<\/item>/gi : /<entry[\s>][\s\S]*?<\/entry>/gi;
  return text.match(pattern) || [];
}

/**
 * Parse an RSS 2.0 or Atom document into `{ title, url, timestampMs }` rows.
 * Rows without a title, an http(s) link or a parseable date are dropped.
 * @param {string} xml
 * @returns {Array<{title: string, url: string, timestampMs: number}>}
 */
export function parseFeedItems(xml) {
  const items = [];
  for (const block of itemBlocks(xml)) {
    const title = elementText(firstElement(block, 'title'));
    const url = itemLink(block);
    const dateText = elementText(firstElement(block, 'pubDate'))
      || elementText(firstElement(block, 'published'))
      || elementText(firstElement(block, 'updated'))
      || elementText(firstElement(block, 'dc:date'));
    const timestampMs = parseFeedDate(dateText);
    if (!title || !url || !Number.isFinite(timestampMs)) continue;
    items.push({ title, url, timestampMs });
  }
  return items;
}

/** One feed row → event fields (null when it falls outside the news window). */
export function newsItemToEvent(item, feed, { pack = null, nowMs = Date.now() } = {}) {
  if (!item || nowMs - item.timestampMs > NEWS_WINDOW_MS || item.timestampMs - nowMs > FUTURE_TOLERANCE_MS) return null;
  const host = new URL(item.url).hostname.replace(/^www\./, '');
  const place = pack?.matchPlaceInText ? pack.matchPlaceInText(item.title) : null;
  const topic = classifyHeadline(item.title);
  return {
    id: `news:${shortHash(item.url)}`,
    source: 'indonesia-news',
    type: 'news',
    subtype: topic,
    timestamp: new Date(Math.min(item.timestampMs, nowMs)).toISOString(),
    location: place ? { lat: place.lat, lon: place.lon } : null,
    title: item.title,
    description: feed.outlet,
    severity: 'info',
    confidence: place ? 0.35 : 0.3,
    status: 'live',
    country: 'ID',
    province: place?.province || null,
    provinceCode: place?.provinceCode || null,
    city: place?.city || null,
    sourceUrl: item.url,
    attribution: `${feed.outlet} (${host}) — headline and link only`,
    raw: {
      outlet: feed.outlet,
      feed: feed.id,
      host,
      topic,
      locationMethod: place ? 'name-match' : 'none',
      matchedPlace: place?.name || null,
    },
  };
}

/** Validators and last good rows per feed, kept across sweeps for conditional polling and fallback. */
const feedCache = new Map();

/** Test seam: forget every feed's validators and cached rows. */
export function resetNewsFeedCache() {
  feedCache.clear();
}

function feedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
}

/** "fetch failed" alone says nothing; undici keeps the real reason on `cause`. */
function describeError(error) {
  const message = String(error?.message || error);
  const cause = error?.cause?.code || error?.cause?.message;
  return (cause && !message.includes(cause) ? `${message} (${cause})` : message).slice(0, 120);
}

/**
 * One request, retried once when the connection itself fails (reset, DNS,
 * timeout). An HTTP error status is an answer, not a network blip, and is
 * never retried. The engine's first sweep runs while the CCTV catalogs and
 * every other provider are connecting too, and on congested networks a few
 * feeds drop out of that burst and then answer normally a second later.
 *
 * Every attempt (connection and body alike) is bounded by what is left of the
 * sweep's `deadline`, and a retry only starts when enough of it remains.
 */
async function requestFeed(feed, headers, { fetchImpl, signal, retryDelayMs, deadline, clock }) {
  let lastError = null;
  for (let attempt = 0; attempt < FEED_ATTEMPTS; attempt += 1) {
    // The first attempt always runs, capped by what is left of the budget; the
    // catch below decides whether a retry still has room.
    const timeoutMs = Math.max(1, Math.min(FEED_TIMEOUT_MS, deadline - clock()));
    try {
      return await fetchImpl(feed.url, { headers, redirect: 'follow', signal: feedSignal(signal, timeoutMs) });
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === FEED_ATTEMPTS - 1) break;
      if (deadline - clock() < retryDelayMs + MIN_ATTEMPT_MS) break;
      await sleep(retryDelayMs, signal);
    }
  }
  throw lastError || new Error('no time left in this sweep');
}

/** Fetch one feed; never throws. */
async function loadFeed(feed, { fetchImpl, signal, nowMs, retryDelayMs, deadline, clock }) {
  const cached = feedCache.get(feed.id) || null;
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
  try {
    const response = await requestFeed(feed, headers, { fetchImpl, signal, retryDelayMs, deadline, clock });
    if (response.status === 304 && cached) {
      try { await response.body?.cancel?.(); } catch { /* nothing to release */ }
      cached.checkedAt = nowMs;
      return { feed, state: 'not-modified', items: cached.items, error: null };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > FEED_MAX_BYTES) throw new Error(`feed larger than ${FEED_MAX_BYTES} bytes`);
    const items = parseFeedItems(text);
    if (!items.length) throw new Error('no dated items with links');
    feedCache.set(feed.id, {
      etag: response.headers?.get?.('etag') || null,
      lastModified: response.headers?.get?.('last-modified') || null,
      items,
      fetchedAt: nowMs,
      checkedAt: nowMs,
    });
    return { feed, state: 'ok', items, error: null };
  } catch (error) {
    const message = describeError(error);
    // A feed that fails keeps serving its last good rows; the news window
    // still ages them out, so a dead feed fades instead of freezing.
    if (cached?.items?.length) return { feed, state: 'stale', items: cached.items, error: message };
    return { feed, state: 'error', items: [], error: message };
  }
}

export const indonesiaNewsProvider = defineProvider({
  id: 'indonesia-news',
  name: 'Indonesian news (ANTARA, Setkab + national outlets)',
  category: 'news',
  region: 'ID',
  auth: 'keyless',
  intervalMs: 10 * 60_000,
  retentionMs: NEWS_WINDOW_MS,
  maxEvents: 1200,
  attribution: 'News headlines: ANTARA, Sekretariat Kabinet RI, detikNews, CNN Indonesia, CNBC Indonesia, Liputan6, Okezone, JPNN, Republika, BBC News Indonesia, SINDOnews, Media Indonesia',
  license: 'Publisher RSS feeds; headline, link and time only — articles stay on the publisher sites',
  sourceUrl: 'https://www.antaranews.com/rss',
  async fetch({
    fetchImpl = fetch,
    signal,
    pack,
    now = Date.now,
    feedRetryDelayMs = DEFAULT_FEED_RETRY_DELAY_MS,
    sweepBudgetMs = NEWS_SWEEP_BUDGET_MS,
    clock = Date.now,
  }) {
    // `now` dates the headlines (tests pin it); the budget runs on the real clock.
    const nowMs = now();
    const deadline = clock() + sweepBudgetMs;
    const results = await Promise.all(NEWS_FEEDS.map((feed) => loadFeed(feed, { fetchImpl, signal, nowMs, retryDelayMs: feedRetryDelayMs, deadline, clock })));
    if (results.every((result) => !result.items.length)) {
      throw new Error(`All ${results.length} news feeds failed: ${results.map((result) => `${result.feed.id} ${result.error}`).join('; ').slice(0, 240)}`);
    }
    const events = [];
    const seenLinks = new Set();
    const seenTitles = new Set();
    for (const { feed, items } of results) {
      for (const item of items) {
        const event = newsItemToEvent(item, feed, { pack, nowMs });
        if (!event) continue;
        // Letters and digits of any script, so punctuation and case differences
        // collapse but two different non-Latin headlines never share a key.
        const titleKey = event.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (seenLinks.has(event.sourceUrl) || (titleKey && seenTitles.has(titleKey))) continue;
        seenLinks.add(event.sourceUrl);
        if (titleKey) seenTitles.add(titleKey);
        events.push(event);
      }
    }
    const located = events.filter((event) => event.location).length;
    const feedsOk = results.filter((result) => result.state === 'ok' || result.state === 'not-modified').length;
    return {
      events,
      metrics: {
        news_articles_72h: { value: events.length, kind: 'count', threshold: 50, label: 'Indonesian news headlines (72 h)', source: 'indonesia-news' },
      },
      meta: {
        located,
        unlocated: events.length - located,
        feedsOk,
        feedsTotal: results.length,
        feeds: results.map((result) => ({ id: result.feed.id, outlet: result.feed.outlet, state: result.state, items: result.items.length, error: result.error })),
      },
    };
  },
});

export default indonesiaNewsProvider;
