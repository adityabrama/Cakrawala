import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
} from '../../vite.config.js';

test('CCTV upstream frame fetch supplies a bounded abort signal', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  assert.equal(result, null);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, 'test timeout should settle promptly');
  assert.ok(CCTV_FRAME_FETCH_TIMEOUT_MS < 10_000, 'production timeout must beat the active refresh cadence');
});

test('CCTV upstream frame fetch returns a valid image response', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, Buffer.from([1, 2, 3]));
});

test('CCTV upstream frame fetch accepts a mislabelled JPEG only when the bytes are an image', async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const accepted = await fetchCctvImageFromUpstream('https://images.data.gov.sg/a.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response(jpeg, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
  });
  assert.equal(accepted?.contentType, 'image/jpeg');

  const blockedPage = await fetchCctvImageFromUpstream('https://images.data.gov.sg/b.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response('<html>blocked by upstream</html>', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
  });
  assert.equal(blockedPage, null, 'binary-labelled bytes that are not an image are rejected');

  const declaredHtml = await fetchCctvImageFromUpstream('https://example.com/c.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response(jpeg, { status: 200, headers: { 'Content-Type': 'text/html' } }),
  });
  assert.equal(declaredHtml, null, 'a declared non-image type is never sniffed');
});
