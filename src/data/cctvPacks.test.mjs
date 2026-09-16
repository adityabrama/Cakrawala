import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSingaporeSnapshotResolver,
  fallbackCameraHeading,
  loadCctvPacks,
  parseBandaAcehCameras,
  parseBandungCameras,
  parseBanjarmasinCameras,
  parseBengkuluCameras,
  parseDigitrafficCameras,
  parseHongKongCameras,
  parsePalembangCameras,
  parseSalatigaCameras,
  parseSemarangCameras,
  parseSidoarjoCameras,
  parseSingaporeCameras,
  parseYogyakartaCameras,
} from './cctvPacks.js';

test('Yogyakarta keeps only public cameras with coordinates and HLS links', () => {
  const cameras = parseYogyakartaCameras([
    { cctv_id: '1', cctv_title: 'Simpang APMD (PTZ)', cctv_link: 'https://cctvjss.jogjakota.go.id/atcs/ATCS_apmd.stream/playlist.m3u8', cctv_latitude: '-7.7919', cctv_longitude: '110.3916', cctv_status: '0' },
    { cctv_id: '2', cctv_title: 'Private', cctv_link: 'https://cctvjss.jogjakota.go.id/a/playlist.m3u8', cctv_latitude: '-7.79', cctv_longitude: '110.39', cctv_status: '1' },
    { cctv_id: '3', cctv_title: 'No coordinates', cctv_link: 'https://cctvjss.jogjakota.go.id/b/playlist.m3u8', cctv_latitude: '', cctv_longitude: '', cctv_status: '0' },
    { cctv_id: '4', cctv_title: 'Not HLS', cctv_link: 'https://youtube.com/watch?v=x', cctv_latitude: '-7.79', cctv_longitude: '110.39', cctv_status: '0' },
  ]);
  assert.equal(cameras.length, 1);
  assert.deepEqual(
    { id: cameras[0].id, feedType: cameras[0].feedType, city: cameras[0].city, cityId: cameras[0].cityId, lat: cameras[0].lat },
    { id: 'jogja-1', feedType: 'hls', city: 'Yogyakarta', cityId: 'yogyakarta', lat: -7.7919 },
  );
  assert.equal(cameras[0].headingDeg, fallbackCameraHeading('jogja-1'));
});

test('Bandung reads the Pelindung list and names the managing agency', () => {
  const [camera] = parseBandungCameras([
    { id: '37aeb2b6', cctv_name: 'CCTV BCH Laswi 1', lat: '-6.918449', lng: '107.631681', stream_cctv: 'https://pelindung.bandung.go.id:3443/video/DAHUA/bch.m3u8', dinas: 'BCH' },
    { id: 'bad', cctv_name: 'Outside Indonesia', lat: '51.5', lng: '-0.12', stream_cctv: 'https://pelindung.bandung.go.id:3443/video/x.m3u8', dinas: 'X' },
  ]);
  assert.equal(camera.id, 'bandung-37aeb2b6');
  assert.equal(camera.provider, 'Pemerintah Kota Bandung (BCH)');
  assert.equal(camera.groundElevationM, 740);
  assert.equal(camera.url, 'https://pelindung.bandung.go.id:3443/video/DAHUA/bch.m3u8');
});

test('Banda Aceh derives the stream and snapshot beside each embed page', () => {
  const cameras = parseBandaAcehCameras([
    { name: 'Bustanussalatin 7', pengelola: 'DISKOMINFOTIK Kota Banda Aceh', url: 'https://api.bandaacehkota.go.id/cctv/5031c4f6-655d-4610-9adf-85a0f5f3b52e.html', latitude: '5.55014', longitude: '95.3175', is_active: true },
    { name: 'Inactive', url: 'https://api.bandaacehkota.go.id/cctv/021969d5-9423-48e7-8da3-1fb9a60d90dd.html', latitude: '5.55', longitude: '95.31', is_active: false },
  ]);
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].url, 'https://api.bandaacehkota.go.id/cctv/memfs/5031c4f6-655d-4610-9adf-85a0f5f3b52e.m3u8');
  assert.equal(cameras[0].snapshotUrl, 'https://api.bandaacehkota.go.id/cctv/memfs/5031c4f6-655d-4610-9adf-85a0f5f3b52e.jpg');
  assert.match(cameras[0].license, /CC BY 4\.0/);
});

test('Palembang keeps public, active cameras and swaps GeoJSON coordinate order', () => {
  const cameras = parsePalembangCameras({
    data: [
      { cctv_id: 'CCTV-SPBB-42', cctv_title: 'CCTV SP BOM BARU', cctv_scope: 'publik', cctv_status: 'active', location: { coordinates: [104.7788, -2.9776] }, cctv_link: 'https://stream.palembang.go.id/cam42/index.m3u8', cctv_opd: { nama_opd: 'Dinas Perhubungan' } },
      { cctv_id: 'CCTV-INT-1', cctv_title: 'Internal', cctv_scope: 'internal', cctv_status: 'active', location: { coordinates: [104.77, -2.97] }, cctv_link: 'https://stream.palembang.go.id/cam1/index.m3u8' },
    ],
  });
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].lat, -2.9776);
  assert.equal(cameras[0].lon, 104.7788);
  assert.equal(cameras[0].provider, 'Dinas Perhubungan');
});

test('Salatiga parses the inline camera list with escaped slashes', () => {
  const html = '<script>window.cams=[{"id":"627764fa-19e6-44a0-adef-de54f4f851f9","nama":"Gerbang Masuk","lokasi":"Kompleks Sukowati","tautan":"https:\\/\\/restreamer.salatiga.go.id\\/memfs\\/157deca9.m3u8","gambar":"https:\\/\\/cctv.salatiga.go.id\\/storage\\/cuplikan\\/627764fa.jpg?v=1","lat":"-7.331018","lng":"110.500935","grup":"Kompleks Sukowati"}];</script>';
  const [camera] = parseSalatigaCameras(html);
  assert.equal(camera.id, 'salatiga-627764fa-19e6-44a0-adef-de54f4f851f9');
  assert.equal(camera.name, 'Kompleks Sukowati · Gerbang Masuk');
  assert.equal(camera.url, 'https://restreamer.salatiga.go.id/memfs/157deca9.m3u8');
  assert.equal(camera.snapshotUrl, 'https://cctv.salatiga.go.id/storage/cuplikan/627764fa.jpg?v=1');
  assert.equal(camera.streamReferer, 'https://cctv.salatiga.go.id/', 'the stream server rejects requests without the portal referer');
});

test('Bengkulu keeps its redirecting stream links for the HLS proxy to follow', () => {
  const html = 'const cameras = [{"id":1,"name":"Simpang Kominfo","stream":"https:\\/\\/cctv.bengkulukota.go.id\\/api\\/cctv\\/1\\/stream","lat":-3.7991162,"lng":102.2723309,"status":"online"},{"id":2,"name":"Simpang Jam","stream":"https:\\/\\/cctv.bengkulukota.go.id\\/api\\/cctv\\/2\\/stream","lat":-3.793733,"lng":102.2702546,"status":"offline"}];';
  const cameras = parseBengkuluCameras(html);
  assert.deepEqual(cameras.map((camera) => camera.id), ['bengkulu-1', 'bengkulu-2']);
  assert.equal(cameras[0].url, 'https://cctv.bengkulukota.go.id/api/cctv/1/stream');
  assert.equal(cameras[0].feedType, 'hls');
});

test('Banjarmasin reads the maps GeoJSON', () => {
  const [camera] = parseBanjarmasinCameras({
    data: { features: [{ properties: { uuid: '6bf68c1e', name: 'Kamboja Taman View 1', latitude: '-3.3220', longitude: '114.5875', url: 'https://rtsp-pemko-bjm.aldilinux.my.id/memfs/89775be6.m3u8' } }] },
  });
  assert.equal(camera.id, 'banjarmasin-6bf68c1e');
  assert.equal(camera.city, 'Banjarmasin');
  assert.equal(camera.streamReferer, 'https://cctv.banjarmasinkota.go.id/', 'the restreamer rejects requests without the portal referer');
});

test('Singapore cameras resolve their rotating image at frame time', () => {
  const [camera] = parseSingaporeCameras({
    items: [{ cameras: [{ camera_id: '2701', image: 'https://images.data.gov.sg/api/traffic-images/2026/09/a.jpg', location: { latitude: 1.447, longitude: 103.7716 } }] }],
  });
  assert.equal(camera.id, 'sg-2701');
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.snapshotResolver, 'sg-lta');
});

test('Hong Kong XML keeps only official snapshot URLs and decodes entities', () => {
  const xml = '<image-list><image><key>H429F</key><region>Hong Kong Island</region><district>Southern</district><description>Aberdeen Praya Road &amp; Fish Market</description><latitude>22.24845</latitude><longitude>114.1505</longitude><url>https://tdcctv.data.one.gov.hk/H429F.JPG</url></image><image><key>BAD</key><latitude>22.3</latitude><longitude>114.1</longitude><url>https://example.com/BAD.JPG</url></image></image-list>';
  const cameras = parseHongKongCameras(xml);
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].name, 'Aberdeen Praya Road & Fish Market');
  assert.equal(cameras[0].city, 'Hong Kong · Southern');
});

test('Finland takes one in-collection preset per gathering station', () => {
  const cameras = parseDigitrafficCameras({
    features: [
      { geometry: { coordinates: [23.99616, 60.05374, 0] }, properties: { name: 'kt51_Inkoo', collectionStatus: 'GATHERING', presets: [{ id: 'C0150301', inCollection: false }, { id: 'C0150302', inCollection: true }] } },
      { geometry: { coordinates: [24.0, 60.1, 0] }, properties: { name: 'removed', collectionStatus: 'REMOVED_TEMPORARILY', presets: [{ id: 'C0999901', inCollection: true }] } },
    ],
  });
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, 'fi-C0150302');
  assert.equal(cameras[0].url, 'https://weathercam.digitraffic.fi/C0150302.jpg');
  assert.equal(cameras[0].name, 'kt51 Inkoo');
});

test('one failing pack never blocks the others', async () => {
  const packs = [
    { id: 'ok', url: 'https://ok.example/list', kind: 'json', parse: (list) => list.map((id) => ({ id })) },
    { id: 'down', url: 'https://down.example/list', kind: 'json', parse: () => [] },
    { id: 'off', url: 'https://off.example/list', kind: 'json', parse: () => [{ id: 'never' }] },
  ];
  const warnings = [];
  const fetchImpl = async (url) => {
    if (url.includes('down')) throw new Error('connect timeout');
    return { ok: true, json: async () => ['a', 'b'] };
  };
  const cameras = await loadCctvPacks(packs, {
    fetchImpl,
    isEnabled: (id) => id !== 'off',
    log: { log() {}, warn: (message) => warnings.push(message) },
  });
  assert.deepEqual(cameras.map((camera) => camera.id), ['a', 'b']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /down/);
});

test('the Singapore resolver caches its list and shares one refresh', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ items: [{ cameras: [{ camera_id: '1701', image: `https://images.data.gov.sg/api/traffic-images/${calls}.jpg`, location: { latitude: 1.3, longitude: 103.8 } }] }] }),
    };
  };
  const resolve = createSingaporeSnapshotResolver({ fetchImpl, ttlMs: 60_000 });
  const [first, second] = await Promise.all([resolve('sg-1701'), resolve('1701')]);
  assert.equal(first, 'https://images.data.gov.sg/api/traffic-images/1.jpg');
  assert.equal(second, first);
  assert.equal(await resolve('sg-missing'), null);
  assert.equal(calls, 1);
});

test('a pack that is down serves its cached catalog and a good fetch refreshes the cache', async () => {
  const packs = [
    { id: 'up', url: 'https://up.example/list', kind: 'json', parse: (list) => list.map((id) => ({ id })) },
    { id: 'down', url: 'https://down.example/list', kind: 'json', parse: () => [] },
    { id: 'down-uncached', url: 'https://gone.example/list', kind: 'json', parse: () => [] },
  ];
  const store = new Map([['down', { savedAt: Date.now() - 5 * 3_600_000, cameras: [{ id: 'cached-1' }, { id: 'cached-2' }] }]]);
  const cache = {
    read: async (id) => store.get(id) || null,
    write: async (id, cameras) => { store.set(id, { savedAt: Date.now(), cameras }); },
  };
  const warnings = [];
  const fetchImpl = async (url) => {
    if (!url.includes('up')) throw new Error('ECONNRESET');
    return { ok: true, json: async () => ['fresh'] };
  };
  const cameras = await loadCctvPacks(packs, { fetchImpl, cache, log: { log() {}, warn: (message) => warnings.push(message) } });
  assert.deepEqual(cameras.map((camera) => camera.id), ['fresh', 'cached-1', 'cached-2']);
  assert.deepEqual(store.get('up').cameras, [{ id: 'fresh' }], 'a successful fetch is remembered');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /down catalog unavailable \(ECONNRESET\); using 2 cached cameras from 5 h ago/);
  assert.match(warnings[1], /down-uncached catalog unavailable: ECONNRESET/);

  // An empty result never overwrites a good cache, and a broken cache is ignored.
  const emptyFetch = async () => ({ ok: true, json: async () => [] });
  await loadCctvPacks([packs[0]], { fetchImpl: emptyFetch, cache, log: { log() {}, warn() {} } });
  assert.deepEqual(store.get('up').cameras, [{ id: 'fresh' }]);
  const broken = { read: async () => { throw new Error('disk'); }, write: async () => { throw new Error('disk'); } };
  const survived = await loadCctvPacks(packs.slice(0, 2), { fetchImpl, cache: broken, log: { log() {}, warn() {} } });
  assert.deepEqual(survived.map((camera) => camera.id), ['fresh']);
});

test('Semarang flattens map points into one camera per published link', () => {
  const BS = String.fromCharCode(92);
  const html = [
    '<html><script>',
    'var cctvs = [',
    '{"cctv_id":414,"owner_name":"KYAI SALEH","lat":"-6.986660206981591","lng":"110.41393529540247","links":[',
    '{"id":307,"name":"KYAI SALEH","owner_name":"DINAS PERHUBUNGAN KOTA SEMARANG","url":"https://livepantau.semarangkota.go.id/ba20c7a2-f499-48c4-af4f-815068f678a0/index.m3u8","status":1},',
    '{"id":308,"name":"KYAI SALEH [selatan]","owner_name":"DPU KOTA SEMARANG","url":"https://livepantau.semarangkota.go.id/162c2b72-d3a6-490e-b15e-eca621897f3b/index.m3u8","status":1},',
    '{"id":309,"name":"Elsewhere","owner_name":"X","url":"https://youtube.com/watch?v=x","status":1}]},',
    '{"cctv_id":9,"owner_name":"OUT OF BOUNDS","lat":"51.5","lng":"-0.12","links":[',
    '{"id":900,"name":"London","owner_name":"X","url":"https://livepantau.semarangkota.go.id/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/index.m3u8","status":1}]}',
    '];</script></html>',
  ].join('');
  const cameras = parseSemarangCameras(html);
  assert.deepEqual(cameras.map((camera) => camera.id), ['semarang-307', 'semarang-308']);
  assert.equal(cameras[0].city, 'Semarang');
  assert.equal(cameras[0].cityId, 'semarang');
  assert.equal(cameras[0].feedType, 'hls');
  assert.equal(cameras[0].provider, 'Pemerintah Kota Semarang (DINAS PERHUBUNGAN KOTA SEMARANG)');
  assert.equal(cameras[0].name, 'KYAI SALEH');
  // A bracket inside a camera name must not end the array slice early.
  assert.equal(cameras[1].name, 'KYAI SALEH · KYAI SALEH [selatan]');
  assert.equal(Math.round(cameras[0].lat * 1000) / 1000, -6.987);
  assert.equal(parseSemarangCameras('<html>no catalog here</html>').length, 0);
  assert.ok(BS);
});

test('Sidoarjo routes its internal stream through the portal proxy and honours visibility', () => {
  const BS = String.fromCharCode(92);
  const escaped = 'http:' + BS + '/' + BS + '/127.0.0.1:3000/192_168_100_11/output.m3u8';
  const records = [
    '{"nama":"SIMPANG 4 SERUNI C1","jalan":"","status_online":true,"video_src":"' + escaped + '","latitude":-7.399408,"longitude":112.727162,"visible":true}',
    '{"nama":"GAJAHMADA ARAH UTARA","jalan":"Jalan Gajah Mada","status_online":false,"video_src":"http://127.0.0.1:3000/192_168_100_15/output.m3u8","latitude":-7.456800,"longitude":112.717500,"visible":true}',
    '{"nama":"HIDDEN","jalan":"","status_online":true,"video_src":"http://127.0.0.1:3000/192_168_100_20/output.m3u8","latitude":-7.4,"longitude":112.7,"visible":false}',
    '{"nama":"NO COORDS","jalan":"","status_online":true,"video_src":"http://127.0.0.1:3000/192_168_100_21/output.m3u8","latitude":null,"longitude":null,"visible":true}',
  ].join(',');
  const html = "<script>const cctvData = JSON.parse('[" + records + "]');</script>";
  const cameras = parseSidoarjoCameras(html);
  assert.deepEqual(cameras.map((camera) => camera.id), ['sidoarjo-192_168_100_11', 'sidoarjo-192_168_100_15']);
  assert.equal(cameras[0].city, 'Sidoarjo');
  assert.equal(cameras[0].feedType, 'hls');
  assert.equal(
    cameras[0].url,
    'https://pantaulalindishub.sidoarjokab.go.id/proxy?url=' + btoa('http://127.0.0.1:3000/192_168_100_11/output.m3u8'),
    'the escaped inline URL decodes before it is base64-encoded for the portal proxy',
  );
  assert.equal(cameras[1].name, 'GAJAHMADA ARAH UTARA · Jalan Gajah Mada');
  assert.equal(parseSidoarjoCameras('<html>nothing</html>').length, 0);
});
