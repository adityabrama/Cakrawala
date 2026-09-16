import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  NEWS_FEEDS,
  NEWS_WINDOW_MS,
  decodeEntities,
  indonesiaNewsProvider,
  newsItemToEvent,
  parseFeedDate,
  parseFeedItems,
  resetNewsFeedCache,
} from './indonesiaNews.js';
import { classifyHeadline } from './gdeltIndonesia.js';
import { createEvent } from '../intelligence/eventSchema.js';

const T = Date.parse('2026-09-16T08:00:00Z');
const rfc822 = (ms) => new Date(ms).toUTCString();

const rssItem = ({ title, link = '', guid = '', date = rfc822(T - 600_000) }) => [
  '<item>',
  title,
  link ? `<link>${link}</link>` : '',
  guid ? `<guid>${guid}</guid>` : '',
  date ? `<pubDate>${date}</pubDate>` : '',
  '<description><![CDATA[<img src="x.jpg"/> The article body must never be kept.]]></description>',
  '</item>',
].join('');

const rss = (...items) => `<?xml version="1.0"?><rss><channel><title>Feed</title><link>https://example.co.id/</link>${items.join('')}</channel></rss>`;

beforeEach(() => resetNewsFeedCache());

test('parseFeedItems reads the item shapes Indonesian feeds really publish', () => {
  const items = parseFeedItems(rss(
    // ANTARA: plain title and <link>
    rssItem({ title: '<title>Banjir rendam Bandung</title>', link: 'https://www.antaranews.com/berita/1/banjir' }),
    // detik / CNN Indonesia: no <link> at all, the URL is the <guid>, title in CDATA
    rssItem({ title: '<title><![CDATA[Sopir Travel Ditembak di Wamena]]></title>', guid: 'https://news.detik.com/berita/d-2/sopir' }),
    // Media Indonesia: CDATA wrapped in whitespace and newlines, hash guid next to a real link
    rssItem({ title: '<title>\n   <![CDATA[ Presiden Didesak Evaluasi Menteri ]]>\n  </title>', link: 'https://mediaindonesia.com/politik/3/presiden', guid: 'cc15cd246cdeb02c' }),
    // CNBC: inline markup entity-encoded inside the title; BBC: &amp; inside the link
    rssItem({ title: '<title>Houthi Serang &lt;i&gt;Red Line&lt;/i&gt;, Kita Tak Ragu</title>', link: 'https://www.bbc.com/indonesia/articles/c84?at_medium=RSS&amp;at_campaign=rss' }),
    // No date: dropped
    rssItem({ title: '<title>Undated</title>', link: 'https://example.co.id/undated', date: '' }),
    // Not an http(s) link: dropped
    rssItem({ title: '<title>Bad link</title>', guid: 'cc15cd246cdeb02c' }),
  ));
  assert.deepEqual(items.map((item) => item.title), [
    'Banjir rendam Bandung',
    'Sopir Travel Ditembak di Wamena',
    'Presiden Didesak Evaluasi Menteri',
    'Houthi Serang Red Line, Kita Tak Ragu',
  ]);
  assert.equal(items[1].url, 'https://news.detik.com/berita/d-2/sopir', 'a guid-only item keeps its article URL');
  assert.equal(items[3].url, 'https://www.bbc.com/indonesia/articles/c84?at_medium=RSS&at_campaign=rss');
  assert.equal(items[0].timestampMs, T - 600_000);

  const atom = parseFeedItems('<feed><entry><title type="html">Erupsi Semeru</title><link rel="alternate" href="https://example.go.id/erupsi"/><updated>2026-09-16T07:30:00Z</updated></entry></feed>');
  assert.deepEqual(atom, [{ title: 'Erupsi Semeru', url: 'https://example.go.id/erupsi', timestampMs: Date.parse('2026-09-16T07:30:00Z') }]);
  assert.deepEqual(parseFeedItems('<html>not a feed</html>'), []);
  assert.equal(decodeEntities('A &amp; B &#8211; C &#x2019; &unknown;'), 'A & B – C ’ &unknown;');
});

test('newsItemToEvent keeps headline, link and outlet only, inside the news window', () => {
  const feed = NEWS_FEEDS[0];
  const pack = { matchPlaceInText: (text) => (/Bandung/.test(text) ? { name: 'Bandung', lat: -6.9, lon: 107.6, province: 'Jawa Barat', provinceCode: '32', city: 'Bandung' } : null) };
  const item = { title: 'Banjir rendam Bandung', url: 'https://www.antaranews.com/berita/1/banjir', timestampMs: T - 3_600_000 };
  const event = newsItemToEvent(item, feed, { pack, nowMs: T });
  assert.equal(event.type, 'news');
  assert.equal(event.subtype, 'flood');
  assert.equal(event.source, 'indonesia-news');
  assert.deepEqual(event.location, { lat: -6.9, lon: 107.6 });
  assert.equal(event.raw.locationMethod, 'name-match');
  assert.equal(event.description, feed.outlet, 'the description is the outlet, never the article text');
  assert.match(event.attribution, /ANTARA \(antaranews\.com\) — headline and link only/);
  assert.ok(createEvent(event), 'the event passes the engine schema as-is');
  assert.ok(!JSON.stringify(event).includes('article body'));

  assert.equal(newsItemToEvent({ ...item, timestampMs: T - NEWS_WINDOW_MS - 1 }, feed, { nowMs: T }), null, 'older than the window');
  assert.equal(newsItemToEvent({ ...item, timestampMs: T + 3 * 3_600_000 }, feed, { nowMs: T }), null, 'a clock far in the future is rejected');
  const skewed = newsItemToEvent({ ...item, timestampMs: T + 30 * 60_000 }, feed, { nowMs: T });
  assert.equal(skewed.timestamp, new Date(T).toISOString(), 'small publisher clock skew is clamped to now');
  assert.equal(newsItemToEvent(item, feed, { nowMs: T }).location, null, 'no pack, no fabricated position');
});

function fakeResponse(status, body = '', headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key) => lower[key.toLowerCase()] ?? null },
    text: async () => body,
    body: { cancel: async () => {} },
  };
}

test('one working feed is enough; failures are reported per feed, not as a provider error', async () => {
  const [first, second] = NEWS_FEEDS;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init?.headers || {} });
    if (url === first.url) {
      if (init?.headers?.['If-None-Match'] === '"v1"') return fakeResponse(304);
      return fakeResponse(200, rss(
        rssItem({ title: '<title>Gempa M5,1 di Flores</title>', link: 'https://www.antaranews.com/berita/1/gempa' }),
        rssItem({ title: '<title>Kapal Virgo terbalik</title>', link: 'https://www.antaranews.com/berita/2/kapal' }),
      ), { ETag: '"v1"' });
    }
    if (url === second.url) {
      return fakeResponse(200, rss(
        // Same link as ANTARA's first item: kept once, from the earlier feed.
        rssItem({ title: '<title>Gempa M5.1 guncang Flores</title>', link: 'https://www.antaranews.com/berita/1/gempa' }),
        // Same headline as ANTARA's second item under another link: kept once.
        rssItem({ title: '<title>Kapal Virgo Terbalik</title>', link: 'https://setkab.go.id/kapal' }),
        rssItem({ title: '<title>Presiden lantik menteri</title>', link: 'https://setkab.go.id/lantik' }),
      ));
    }
    throw new Error('connect ETIMEDOUT');
  };

  const result = await indonesiaNewsProvider.fetch({ fetchImpl, now: () => T, feedRetryDelayMs: 0 });
  assert.deepEqual(result.events.map((event) => event.title), ['Gempa M5,1 di Flores', 'Kapal Virgo terbalik', 'Presiden lantik menteri']);
  assert.equal(result.meta.feedsOk, 2);
  assert.equal(result.meta.feedsTotal, NEWS_FEEDS.length);
  assert.equal(result.meta.feeds.find((feed) => feed.id === NEWS_FEEDS[2].id).state, 'error');
  assert.equal(result.metrics.news_articles_72h.value, 3);

  // Second sweep: ANTARA is polled conditionally and answers 304; its rows are reused.
  seen.length = 0;
  const again = await indonesiaNewsProvider.fetch({ fetchImpl, now: () => T, feedRetryDelayMs: 0 });
  assert.equal(seen.find((call) => call.url === first.url).headers['If-None-Match'], '"v1"');
  assert.equal(again.meta.feeds.find((feed) => feed.id === first.id).state, 'not-modified');
  assert.equal(again.events.length, 3);
});

test('a feed that starts failing keeps serving its last good rows, and only a total outage is an error', async () => {
  const [first] = NEWS_FEEDS;
  let down = false;
  const fetchImpl = async (url) => {
    if (url === first.url && !down) {
      return fakeResponse(200, rss(rssItem({ title: '<title>Erupsi Gunung Semeru</title>', link: 'https://www.antaranews.com/berita/9/erupsi' })));
    }
    throw new Error('HTTP 503');
  };
  const before = await indonesiaNewsProvider.fetch({ fetchImpl, now: () => T, feedRetryDelayMs: 0 });
  assert.equal(before.events.length, 1);
  down = true;
  const during = await indonesiaNewsProvider.fetch({ fetchImpl, now: () => T + 600_000, feedRetryDelayMs: 0 });
  assert.equal(during.events.length, 1, 'the cached headline is still served');
  assert.equal(during.meta.feeds.find((feed) => feed.id === first.id).state, 'stale');

  resetNewsFeedCache();
  await assert.rejects(
    indonesiaNewsProvider.fetch({ fetchImpl, now: () => T, feedRetryDelayMs: 0 }),
    new RegExp(`All ${NEWS_FEEDS.length} news feeds failed`),
  );
});

test('a dropped connection is retried once; an HTTP error answer is not', async () => {
  const [first, second] = NEWS_FEEDS;
  const calls = new Map();
  const fetchImpl = async (url) => {
    calls.set(url, (calls.get(url) || 0) + 1);
    if (url === first.url) {
      if (calls.get(url) === 1) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      return fakeResponse(200, rss(rssItem({ title: '<title>Banjir Jakarta</title>', link: 'https://www.antaranews.com/berita/7/banjir' })));
    }
    if (url === second.url) return fakeResponse(503, 'maintenance');
    const error = new TypeError('fetch failed');
    error.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    throw error;
  };
  const result = await indonesiaNewsProvider.fetch({ fetchImpl, now: () => T, feedRetryDelayMs: 0 });
  assert.equal(calls.get(first.url), 2, 'the reset connection was retried');
  assert.equal(result.meta.feeds.find((feed) => feed.id === first.id).state, 'ok');
  assert.equal(calls.get(second.url), 1, 'an HTTP 503 is an answer and is not retried');
  assert.equal(result.meta.feeds.find((feed) => feed.id === second.id).error, 'HTTP 503');
  assert.equal(
    result.meta.feeds.find((feed) => feed.id === NEWS_FEEDS[2].id).error,
    'fetch failed (UND_ERR_CONNECT_TIMEOUT)',
    'the underlying network cause is surfaced instead of a bare "fetch failed"',
  );
});

test('a hanging feed cannot hold the sweep past its budget (the engine drops a provider at 30 s)', async () => {
  const [first, second] = NEWS_FEEDS;
  const fetchImpl = (url, init) => {
    if (url === first.url) {
      return Promise.resolve(fakeResponse(200, rss(rssItem({ title: '<title>Banjir Jakarta</title>', link: 'https://www.antaranews.com/berita/8/banjir' }))));
    }
    if (url === second.url) {
      // Never answers: only the abort signal ends it.
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')), { once: true }));
    }
    return Promise.resolve(fakeResponse(404));
  };
  const started = Date.now();
  const result = await indonesiaNewsProvider.fetch({ fetchImpl, now: () => T, feedRetryDelayMs: 0, sweepBudgetMs: 400 });
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 3_000, `the sweep finished in ${elapsedMs} ms instead of waiting out the hung feed`);
  assert.equal(result.meta.feeds.find((feed) => feed.id === first.id).state, 'ok');
  assert.equal(result.meta.feeds.find((feed) => feed.id === second.id).state, 'error');
  assert.equal(result.events.length, 1);
});

test('zone-less dates are read as WIB, Atom self links are skipped, and non-Latin headlines stay distinct', async () => {
  assert.equal(parseFeedDate('2026-09-16 15:44:10'), Date.parse('2026-09-16T08:44:10Z'), 'WIB is UTC+7 whatever the server timezone');
  assert.equal(parseFeedDate('2026-09-16T15:44'), Date.parse('2026-09-16T08:44:00Z'));
  assert.equal(parseFeedDate('Wed, 16 Sep 2026 15:44:10 +0700'), Date.parse('2026-09-16T08:44:10Z'));
  assert.ok(Number.isNaN(parseFeedDate('')));

  const [atom] = parseFeedItems('<feed><entry><title>Gempa</title><link rel="self" href="https://example.go.id/api/entry/1"/><link rel="enclosure" href="https://example.go.id/foto.jpg"/><link rel="alternate" href="https://example.go.id/berita/gempa"/><updated>2026-09-16T07:30:00Z</updated></entry></feed>');
  assert.equal(atom.url, 'https://example.go.id/berita/gempa');

  const [first] = NEWS_FEEDS;
  const fetchImpl = async (url) => (url === first.url
    ? fakeResponse(200, rss(
      rssItem({ title: '<title>地震のニュース</title>', link: 'https://example.co.id/a' }),
      rssItem({ title: '<title>أخبار الزلزال</title>', link: 'https://example.co.id/b' }),
    ))
    : fakeResponse(404));
  const result = await indonesiaNewsProvider.fetch({ fetchImpl, now: () => T, feedRetryDelayMs: 0 });
  assert.equal(result.events.length, 2, 'headlines with no Latin letters are not merged into one');
});

test('headline topics match whole words only', () => {
  assert.equal(classifyHeadline('Erupsi Gunung Semeru, status naik'), 'volcano');
  assert.equal(classifyHeadline('Wisata Gunung Kidul ramai saat libur'), 'general', 'a bare "gunung" is a mountain, not a volcano');
  assert.equal(classifyHeadline('Perjalanan dinas pejabat disorot'), 'general', '"jalan" inside perjalanan is not transport');
  assert.equal(classifyHeadline('Tarif tol Jagorawi naik'), 'transport');
  assert.equal(classifyHeadline('Sport report: timnas menang'), 'general', '"port" inside report/sport is not maritime');
  assert.equal(classifyHeadline('KM Virgo: kapal terbalik di perairan Bali'), 'maritime');
  assert.equal(classifyHeadline('Karhutla ganggu penerbangan'), 'fire');
  assert.equal(classifyHeadline('Gempabumi M5,2 guncang Flores'), 'earthquake');
});
