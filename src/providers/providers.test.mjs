import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defineProvider, fetchJson, nameKey, severityFromMagnitude, shortHash, attachAdministrative } from './provider.js';
import { parseBmkgQuake, hasTsunamiPotential, bmkgQuakesProvider } from './bmkgQuakes.js';
import { parseUsgsFeature, usgsIndonesiaUrl } from './usgsIndonesia.js';
import { parseBnpbFeature, classifyBnpbCategory } from './bnpbWeekly.js';
import { parseMagmaLevels, matchVolcano, magmaVolcanoProvider } from './magmaVolcano.js';
import { parseGdeltArticle, parseGdeltDate, classifyHeadline } from './gdeltIndonesia.js';
import { pickForecastSlots, buildWeatherPoint } from './bmkgWeather.js';
import { normalizeOpenMeteoWeather, normalizeOpenMeteoAir } from './openMeteo.js';
import { parseWorldBankSeries } from './worldBank.js';
import { parseFrankfurter } from './frankfurter.js';
import { parseReliefwebDisasters, reliefwebProvider } from './reliefweb.js';
import { SWEEP_PROVIDERS, ALL_PROVIDERS, describeProviders } from './index.js';
import { runProvider } from '../intelligence/sweep.js';

const NOW = Date.parse('2026-09-15T06:00:00Z');

test('provider contract: ids are kebab-case, every provider declares attribution and cadence', () => {
  const ids = new Set();
  for (const provider of ALL_PROVIDERS) {
    assert.match(provider.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(provider.id), `duplicate id ${provider.id}`);
    ids.add(provider.id);
    assert.ok(provider.attribution.length > 5, `${provider.id} attribution`);
    assert.ok(provider.onDemand || provider.intervalMs >= 60_000, `${provider.id} cadence`);
    assert.equal(typeof provider.isConfigured, 'function');
  }
  assert.throws(() => defineProvider({ id: 'Bad_Id', name: 'x', category: 'x', attribution: 'x', fetch() {} }));
  const described = describeProviders({});
  assert.ok(described.every((entry) => !('fetch' in entry)));
  assert.equal(described.find((entry) => entry.id === 'reliefweb-indonesia').configured, false);
  assert.equal(describeProviders({ RELIEFWEB_APPNAME: 'x' }).find((entry) => entry.id === 'reliefweb-indonesia').configured, true);
  assert.equal(severityFromMagnitude(6.4), 'high');
  assert.equal(nameKey('Gunung Tangkuban Parahu'), 'tangkuban parahu');
  assert.equal(shortHash('a'), shortHash('a'));
  assert.notEqual(shortHash('a'), shortHash('b'));
});

test('fetchJson rejects non-JSON bodies and non-2xx responses', async () => {
  const fetchImpl = async (url) => new Response(url.includes('bad') ? '<html>' : '{"ok":true}', { status: url.includes('500') ? 500 : 200 });
  assert.deepEqual(await fetchJson('https://x.test/good', { fetchImpl, retries: 0 }), { ok: true });
  await assert.rejects(fetchJson('https://x.test/bad', { fetchImpl, retries: 0 }), /Non-JSON/);
  await assert.rejects(fetchJson('https://x.test/500', { fetchImpl, retries: 0 }), /HTTP 500/);
});

test('BMKG earthquake rows normalize coordinates, depth, tsunami potential, and felt status', () => {
  const row = { Tanggal: '15 Sep 2026', Jam: '09:27:41 WIB', DateTime: '2026-09-15T02:27:41+00:00', Coordinates: '-8.26,120.57', Magnitude: '3.1', Kedalaman: '7 km', Wilayah: 'Pusat gempa berada di laut 41 km utara Ruteng Manggarai', Potensi: 'Gempa ini dirasakan untuk diteruskan pada masyarakat', Dirasakan: 'II-III Kab. Manggarai', Shakemap: '20260915092741.mmi.jpg' };
  const event = parseBmkgQuake(row, 'felt', { nowIso: '2026-09-15T06:00:00Z' });
  assert.equal(event.location.lat, -8.26);
  assert.equal(event.location.depthKm, 7);
  assert.equal(event.magnitude, 3.1);
  assert.equal(event.severity, 'info');
  assert.equal(event.raw.felt, true);
  assert.equal(event.raw.tsunamiPotential, false);
  assert.match(event.raw.shakemap, /^https:\/\/data\.bmkg\.go\.id\//);
  assert.equal(parseBmkgQuake({ ...row, Potensi: 'Berpotensi TSUNAMI' }, 'latest').severity, 'critical');
  assert.equal(hasTsunamiPotential('Tidak berpotensi tsunami'), false);
  assert.equal(parseBmkgQuake({ ...row, Coordinates: 'x' }, 'latest'), null);
  const m6 = parseBmkgQuake({ ...row, Magnitude: '6.2', Potensi: 'Tidak berpotensi tsunami', Dirasakan: undefined }, 'm5-plus');
  assert.equal(m6.severity, 'high');
  assert.equal(m6.raw.felt, false);
});

test('BMKG provider stamps attribution and keeps going when one feed fails', async () => {
  const gempa = { DateTime: '2026-09-15T02:27:41+00:00', Coordinates: '-8.26,120.57', Magnitude: '5.4', Kedalaman: '10 km', Wilayah: 'Laut Flores', Potensi: 'Tidak berpotensi tsunami' };
  const fetchImpl = async (url) => {
    if (url.endsWith('gempaterkini.json')) return new Response('oops', { status: 503 });
    return new Response(JSON.stringify({ Infogempa: { gempa: url.endsWith('autogempa.json') ? gempa : [gempa] } }), { status: 200 });
  };
  const result = await runProvider(bmkgQuakesProvider, { fetchImpl, env: {}, pack: null, now: () => NOW });
  assert.equal(result.state, 'ok');
  assert.equal(result.events.length, 1, 'the same quake from two feeds merges by id');
  assert.equal(result.events[0].attribution, bmkgQuakesProvider.attribution);
  assert.equal(result.meta.failures.length, 1);
  assert.equal(result.metrics.bmkg_latest_magnitude.value, 5.4);
});

test('USGS features map to events with review-based confidence and a bounded Indonesia query', () => {
  const feature = { id: 'us7000abcd', geometry: { coordinates: [128.09, 2.52, 145] }, properties: { mag: 6.2, place: '42 km NE of Pulau Doi', time: 1789450684000, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd', tsunami: 0, felt: 12, status: 'reviewed', alert: 'green' } };
  const event = parseUsgsFeature(feature);
  assert.equal(event.id, 'usgs:us7000abcd');
  assert.equal(event.severity, 'high');
  assert.equal(event.confidence, 0.95);
  assert.equal(event.raw.felt, true);
  assert.equal(event.location.depthKm, 145);
  assert.equal(parseUsgsFeature({ geometry: { coordinates: [1] }, properties: {} }), null);
  const url = usgsIndonesiaUrl({ days: 7 });
  assert.match(url, /minlatitude=-11\.5/);
  assert.match(url, /maxlongitude=141\.5/);
});

test('BNPB weekly features classify categories, sum impact, and age into historical', () => {
  const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[110.7, -7.5], [110.9, -7.5], [110.9, -7.7], [110.7, -7.7], [110.7, -7.5]]] }, properties: { objectid: 3, dt: Date.UTC(2026, 5, 30), kabupaten: 'Sukoharjo', kategori_bencana: 'Kebakaran hutan dan lahan', jumlah_kejadian: 1, meninggal: 0, hilang: 0, luka_sakit: 0, mengungsi: 0, menderita_mengungsi: 0, rumah_rusak: 0, rumah_terendam: 0, lahan_hektar: 6, kronologis: '●\tPada hari Selasa, 30 Juni 2026 telah terjadi kebakaran hutan dan lahan.\n' } };
  const event = parseBnpbFeature(feature, { nowMs: NOW });
  assert.equal(event.type, 'fire');
  assert.equal(event.subtype, 'forest-land-fire');
  assert.equal(event.status, 'historical');
  assert.equal(event.severity, 'info');
  assert.equal(event.city, 'Sukoharjo');
  assert.ok(Math.abs(event.location.lat + 7.58) < 0.05);
  assert.match(event.description, /^Pada hari Selasa/);
  const flood = parseBnpbFeature({ ...feature, properties: { ...feature.properties, dt: NOW - 86_400_000, kategori_bencana: 'Banjir', meninggal: 2, mengungsi: 900 } }, { nowMs: NOW });
  assert.equal(flood.type, 'flood');
  assert.equal(flood.status, 'delayed');
  assert.equal(flood.severity, 'high');
  assert.equal(flood.raw.impact.displaced, 900);
  assert.deepEqual(classifyBnpbCategory('Tanah Longsor'), { type: 'landslide', subtype: 'landslide' });
  assert.equal(parseBnpbFeature({ properties: { kabupaten: 'X' } }), null);
});

test('MAGMA activity table parses level sections and matches bundled volcano positions', async () => {
  const html = `<table>
    <tr><th>Tingkat Aktivitas</th><th>Jumlah</th><th>Gunung Api</th></tr>
    <tr><td rowspan="1"><a>Level IV (Awas)</a><span>Hasil pengamatan…</span></td><td rowspan="1"> 0 </td><td> Tidak ada gunung api Level IV (Awas) </td></tr>
    <tr><td rowspan="3"><a>Level III (Siaga)</a><span>Hasil pengamatan…</span></td><td rowspan="3"> 2 </td></tr>
    <tr><td> Anak Krakatau - Lampung <a href="https://magma.esdm.go.id/v1/gunung-api/laporan/1?signature=abc&amp;x=1">Lihat laporan</a></td></tr>
    <tr><td> Lewotobi Laki-laki - Nusa Tenggara Timur <a href="https://magma.esdm.go.id/v1/gunung-api/laporan/2">Lihat laporan</a></td></tr>
    <tr><td rowspan="2"><a>Level II (Waspada)</a><span>Hasil pengamatan…</span></td><td rowspan="2"> 1 </td></tr>
    <tr><td> Tangkuban Parahu - Jawa Barat <a href="https://magma.esdm.go.id/v1/gunung-api/laporan/3">Lihat laporan</a></td></tr>
    <tr><td rowspan="2"><a>Level I (Normal)</a><span>Hasil pengamatan…</span></td><td rowspan="2"> 1 </td></tr>
    <tr><td> Unknown Peak - Papua <a href="https://magma.esdm.go.id/v1/gunung-api/laporan/4">Lihat laporan</a></td></tr>
  </table>`;
  const rows = parseMagmaLevels(html);
  assert.deepEqual(rows.map((row) => [row.name, row.level]), [['Anak Krakatau', 3], ['Lewotobi Laki-laki', 3], ['Tangkuban Parahu', 2], ['Unknown Peak', 1]]);
  assert.equal(rows[0].reportUrl, 'https://magma.esdm.go.id/v1/gunung-api/laporan/1?signature=abc&x=1');
  const volcanoes = [
    { id: 'Q1', name: 'Anak Krakatau', key: 'anak krakatau', lat: -6.1, lon: 105.42 },
    { id: 'Q2', name: 'Lewotobi Laki-laki', key: 'lewotobi laki laki', lat: -8.54, lon: 122.77 },
    { id: 'Q3', name: 'Tangkuban Perahu', key: 'tangkuban perahu', lat: -6.77, lon: 107.6 },
  ];
  assert.equal(matchVolcano('Tangkuban Parahu', volcanoes).id, 'Q3');
  assert.equal(matchVolcano('Unknown Peak', volcanoes), null);
  const result = await runProvider(magmaVolcanoProvider, { fetchImpl: async () => new Response(html, { status: 200 }), env: {}, pack: { volcanoes }, now: () => NOW });
  assert.equal(result.state, 'ok');
  assert.equal(result.events.length, 4);
  assert.equal(result.events[0].severity, 'high');
  assert.equal(result.events[0].raw.method, 'web-table');
  assert.equal(result.events[3].location, null, 'an unmatched volcano keeps its level without a fabricated position');
  assert.equal(result.metrics.magma_level_3.value, 2);
  assert.equal(result.meta.unplaced, 1);
});

test('GDELT articles keep metadata only and estimate location by place name', () => {
  const pack = { matchPlaceInText: (text) => (/Bandung/.test(text) ? { name: 'Bandung', lat: -6.9, lon: 107.6, province: 'Jawa Barat', provinceCode: '32', city: 'Bandung' } : null) };
  const event = parseGdeltArticle({ url: 'https://example.co.id/banjir-bandung', title: 'Banjir rendam Bandung', seendate: '20260915T053000Z', domain: 'example.co.id', language: 'Indonesian', sourcecountry: 'Indonesia' }, pack);
  assert.equal(event.type, 'news');
  assert.equal(event.subtype, 'flood');
  assert.equal(event.timestamp, '2026-09-15T05:30:00Z');
  assert.deepEqual(event.location, { lat: -6.9, lon: 107.6 });
  assert.equal(event.raw.locationMethod, 'name-match');
  assert.equal(event.confidence, 0.35);
  assert.ok(!('body' in event));
  const unplaced = parseGdeltArticle({ url: 'https://example.com/x', title: 'Pesawat delay', seendate: '20260915T053000Z' }, pack);
  assert.equal(unplaced.location, null);
  assert.equal(unplaced.subtype, 'aviation');
  assert.equal(parseGdeltDate('nope'), null);
  assert.equal(classifyHeadline('Kabar biasa'), 'general');
  assert.equal(parseGdeltArticle({ url: 'ftp://x', title: 'x', seendate: '20260915T053000Z' }), null);
});

test('BMKG weather picks the slot nearest to now and flags severe forecasts', () => {
  const slot = (iso, weather, t = 30) => ({ datetime: iso, weather, weather_desc_en: weather === 63 ? 'Heavy Rain' : 'Sunny', t, hu: 70, ws: 8, wd: 'N', tcc: 50, tp: 0, vs: 10000, analysis_date: '2026-09-15T00:00:00' });
  const payload = { lokasi: { provinsi: 'DKI Jakarta', kotkab: 'Kota Adm. Jakarta Pusat', lat: -6.176, lon: 106.827 }, data: [{ cuaca: [[slot('2026-09-15T03:00:00Z', 1), slot('2026-09-15T06:00:00Z', 1, 33), slot('2026-09-15T09:00:00Z', 63)], [slot('2026-09-16T12:00:00Z', 1)]] }] };
  const { current, next24h } = pickForecastSlots(payload, NOW + 60_000);
  assert.equal(current.datetime, '2026-09-15T06:00:00Z');
  assert.equal(next24h.length, 2, 'the slot three hours ago and the one beyond 24 h are excluded');
  const built = buildWeatherPoint({ id: 'jakarta', name: 'Jakarta', adm4: '31.71.01.1001', provinceCode: '31', lat: -6.2, lon: 106.8 }, payload, { nowMs: NOW });
  assert.equal(built.forecast.current.tempC, 33);
  assert.equal(built.forecast.severe, 'Heavy rain');
  assert.equal(built.event.severity, 'medium');
  assert.equal(built.event.status, 'modeled');
  assert.equal(built.event.raw.severe, 'Heavy rain');
  assert.equal(buildWeatherPoint({ id: 'x' }, { data: [] }), null);
});

test('Open-Meteo, World Bank, Frankfurter, and ReliefWeb payloads normalize with honest freshness', () => {
  const weather = normalizeOpenMeteoWeather({ latitude: -6.2, longitude: 106.8, current: { time: '2026-09-15T05:45', temperature_2m: 31.2, relative_humidity_2m: 60, precipitation: 0, wind_speed_10m: 12, wind_direction_10m: 90, weather_code: 3 }, hourly: { time: ['2026-09-15T06:00', '2026-09-15T07:00'], temperature_2m: [31, 30], precipitation: [0, 1.2], wind_speed_10m: [10, 11], weather_code: [3, 61] } });
  assert.equal(weather.observedAt, '2026-09-15T05:45:00.000Z');
  assert.equal(weather.current.condition, 'Overcast');
  assert.equal(weather.next24h[1].condition, 'Slight rain');
  assert.equal(weather.status, 'modeled');
  assert.equal(normalizeOpenMeteoWeather({ current: {} }), null);
  assert.equal(normalizeOpenMeteoAir({ current: { time: '2026-09-15T05:00', pm2_5: 41.5, pm10: 60, us_aqi: 115 } }).usAqi, 115);

  const series = parseWorldBankSeries([{ page: 1 }, [{ date: '2024', value: 1.4e12 }, { date: '2025', value: null }, { date: '2023', value: 1.37e12 }]]);
  assert.equal(series.latest.year, 2024);
  assert.equal(series.series.length, 2);

  assert.deepEqual(parseFrankfurter({ base: 'USD', date: '2026-09-12', rates: { IDR: 15820.5 } }), { base: 'USD', date: '2026-09-12', idr: 15820.5 });
  assert.equal(parseFrankfurter({ base: 'USD', rates: {} }), null);

  const disasters = parseReliefwebDisasters({ data: [{ id: 51234, fields: { name: 'Indonesia: Floods - Aug 2026', status: 'ongoing', glide: 'FL-2026-000123-IDN', date: { created: '2026-08-20T00:00:00+00:00' }, primary_type: { name: 'Flood' }, url_alias: '/disaster/fl-2026-000123-idn', primary_country: { location: { lat: -2.5, lon: 118 } } } }] });
  assert.equal(disasters[0].subtype, 'flood');
  assert.equal(disasters[0].status, 'delayed');
  assert.equal(disasters[0].sourceUrl, 'https://reliefweb.int/disaster/fl-2026-000123-idn');
  assert.equal(reliefwebProvider.isConfigured({}), false);
});

test('attachAdministrative prefers the polygon locator and falls back to name matching', () => {
  const pack = {
    locateRegency: (lat) => (lat < 0 ? { code: '32.73', name: 'Kota Bandung' } : null),
    provinceName: (code) => ({ 32: 'Jawa Barat', 12: 'Sumatera Utara' })[code] || null,
    matchProvinceInText: (text) => (/Medan/.test(text) ? { code: '12', name: 'Sumatera Utara' } : null),
  };
  const located = attachAdministrative({ location: { lat: -6.9, lon: 107.6 } }, pack, '');
  assert.deepEqual([located.city, located.provinceCode, located.province], ['Kota Bandung', '32', 'Jawa Barat']);
  const named = attachAdministrative({ location: null }, pack, 'Gempa dirasakan di Medan');
  assert.deepEqual([named.provinceCode, named.province], ['12', 'Sumatera Utara']);
  assert.equal(SWEEP_PROVIDERS.length, 9);
});
