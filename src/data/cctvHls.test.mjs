import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeHlsRef,
  encodeHlsRef,
  hlsSiteDomain,
  isAllowedHlsTarget,
  isPrivateHostname,
  looksLikeHlsPlaylist,
  rewriteHlsPlaylist,
} from './cctvHls.js';

const toProxy = (absolute) => `/api/cctv/hls/cam/r/${encodeHlsRef(absolute)}`;
const refsIn = (text) => [...text.matchAll(/\/api\/cctv\/hls\/cam\/r\/([A-Za-z0-9_-]+)/g)].map((m) => decodeHlsRef(m[1]));

test('a master playlist routes every variant through the proxy as an absolute URL', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=272313,RESOLUTION=640x480',
    'chunklist_w1129014282.m3u8',
  ].join('\n');
  const rewritten = rewriteHlsPlaylist(master, 'https://cctvjss.jogjakota.go.id/atcs/ATCS_apmd.stream/playlist.m3u8', toProxy);
  assert.deepEqual(refsIn(rewritten), ['https://cctvjss.jogjakota.go.id/atcs/ATCS_apmd.stream/chunklist_w1129014282.m3u8']);
  assert.ok(rewritten.startsWith('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF'), 'tags survive untouched');
});

test('media playlists rewrite segments and URI attributes, and leave other tags alone', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/k1.bin",IV=0x1',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'bch9.ts',
    '#EXTINF:4.0,',
    'https://pelindung.bandung.go.id:3443/video/DAHUA/bch10.ts',
    '',
  ].join('\r\n');
  const rewritten = rewriteHlsPlaylist(media, 'https://pelindung.bandung.go.id:3443/video/DAHUA/bch.m3u8', toProxy);
  assert.deepEqual(refsIn(rewritten), [
    'https://pelindung.bandung.go.id:3443/video/DAHUA/keys/k1.bin',
    'https://pelindung.bandung.go.id:3443/video/DAHUA/init.mp4',
    'https://pelindung.bandung.go.id:3443/video/DAHUA/bch9.ts',
    'https://pelindung.bandung.go.id:3443/video/DAHUA/bch10.ts',
  ]);
  assert.match(rewritten, /#EXT-X-KEY:METHOD=AES-128,URI="\/api\/cctv\/hls\/cam\/r\/[A-Za-z0-9_-]+",IV=0x1/);
  assert.ok(rewritten.includes('#EXT-X-TARGETDURATION:4'));
});

test('refs round-trip and never decode to a non-http scheme', () => {
  const url = 'https://api.bandaacehkota.go.id/cctv/memfs/5031c4f6.m3u8?token=a/b';
  assert.equal(decodeHlsRef(encodeHlsRef(url)), url);
  assert.equal(decodeHlsRef(encodeHlsRef('file:///etc/passwd')), null);
  assert.equal(decodeHlsRef('%%%not-base64'), null);
});

test('the proxy only reaches the camera host or a sibling on the same site', () => {
  const bandung = 'https://pelindung.bandung.go.id:3443/video/DAHUA/bch.m3u8';
  assert.equal(isAllowedHlsTarget('https://pelindung.bandung.go.id/video/x.ts', bandung), true, 'same host, other port');
  assert.equal(isAllowedHlsTarget('https://cctv-source.bengkulukota.go.id/cam01/index.m3u8', 'https://cctv.bengkulukota.go.id/api/cctv/1/stream'), true, 'city redirect to its own stream server');
  assert.equal(isAllowedHlsTarget('https://evil.example.com/x.ts', bandung), false);
  assert.equal(isAllowedHlsTarget('https://jakarta.go.id/x.ts', bandung), false, 'go.id is not one site');
  assert.equal(isAllowedHlsTarget('http://10.200.49.2/hls/index.m3u8', 'http://10.200.49.2/hls/index.m3u8'), false, 'private addresses are never reachable');
  assert.equal(isAllowedHlsTarget('ftp://pelindung.bandung.go.id/x.ts', bandung), false);
  assert.equal(isAllowedHlsTarget('not a url', bandung), false);
});

test('site domains respect country second-level domains', () => {
  assert.equal(hlsSiteDomain('cctvjss.jogjakota.go.id'), 'jogjakota.go.id');
  assert.equal(hlsSiteDomain('restreamer.salatiga.go.id'), 'salatiga.go.id');
  assert.equal(hlsSiteDomain('api.data.gov.sg'), 'data.gov.sg');
  assert.equal(hlsSiteDomain('rtsp-pemko-bjm.aldilinux.my.id'), 'aldilinux.my.id');
  assert.equal(hlsSiteDomain('tie.digitraffic.fi'), 'digitraffic.fi');
});

test('private hostnames are recognised', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.49.1', '172.20.0.5', '169.254.169.254', '[::1]']) {
    assert.equal(isPrivateHostname(host), true, host);
  }
  for (const host of ['162.55.144.139', '8.8.8.8', 'cctv.jogjakota.go.id']) {
    assert.equal(isPrivateHostname(host), false, host);
  }
});

test('playlists are recognised by content type or by their first line', () => {
  assert.equal(looksLikeHlsPlaylist('application/vnd.apple.mpegurl', ''), true);
  assert.equal(looksLikeHlsPlaylist('application/x-mpegURL', ''), true);
  assert.equal(looksLikeHlsPlaylist('text/plain', '  #EXTM3U\n#EXT-X-VERSION:3'), true);
  assert.equal(looksLikeHlsPlaylist('text/html', '<!DOCTYPE html>'), false);
});
