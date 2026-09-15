import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attachHlsVideo } from './cctvHlsPlayer.js';

function fakeHls({ supported = true } = {}) {
  const instances = [];
  class FakeHls {
    static Events = { ERROR: 'hlsError', FRAG_BUFFERED: 'hlsFragBuffered' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' };
    static isSupported() { return supported; }
    constructor(config) {
      this.config = config;
      this.handlers = new Map();
      this.calls = [];
      instances.push(this);
    }
    on(event, handler) { this.handlers.set(event, handler); }
    emit(event, data) { this.handlers.get(event)?.(event, data); }
    loadSource(url) { this.calls.push(`loadSource ${url}`); }
    attachMedia() { this.calls.push('attachMedia'); }
    startLoad() { this.calls.push('startLoad'); }
    recoverMediaError() { this.calls.push('recoverMediaError'); }
    destroy() { this.calls.push('destroy'); }
  }
  return { loadHls: async () => ({ default: FakeHls }), instances, FakeHls };
}

function manualTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimer: (fn, ms) => { const id = nextId++; pending.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { pending.delete(id); },
    runAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
      return due.map(({ ms }) => ms);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const URL_ = '/api/cctv/hls/bandung-1/playlist.m3u8';

test('a fatal manifest error reloads the playlist after a growing back-off', async () => {
  const { loadHls, instances, FakeHls } = fakeHls();
  const timers = manualTimers();
  attachHlsVideo({}, URL_, { loadHls, ...timers });
  await flush();
  const [hls] = instances;
  assert.deepEqual(hls.calls, [`loadSource ${URL_}`, 'attachMedia']);

  const delays = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    hls.emit(FakeHls.Events.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    delays.push(...timers.runAll());
  }
  assert.deepEqual(delays, [2000, 4000, 8000]);
  assert.equal(hls.calls.filter((call) => call === `loadSource ${URL_}`).length, 4, 'initial load plus three reloads');
  assert.equal(hls.calls.includes('startLoad'), false, 'startLoad cannot recover a missing manifest');

  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
  assert.equal(timers.pending.size, 0, 'the budget is spent');
  assert.equal(hls.calls.at(-1), 'destroy');
});

test('segment errors restart loading, and buffering again refills the retry budget', async () => {
  const { loadHls, instances, FakeHls } = fakeHls();
  const timers = manualTimers();
  attachHlsVideo({}, URL_, { loadHls, ...timers });
  await flush();
  const [hls] = instances;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    hls.emit(FakeHls.Events.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadError' });
    timers.runAll();
  }
  hls.emit(FakeHls.Events.FRAG_BUFFERED, {});
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadError' });
  assert.deepEqual(timers.runAll(), [2000], 'the delay starts over after recovery');
  assert.equal(hls.calls.filter((call) => call === 'startLoad').length, 4);
  assert.equal(hls.calls.includes('destroy'), false);
});

test('detaching cancels a pending retry and releases the player', async () => {
  const { loadHls, instances, FakeHls } = fakeHls();
  const timers = manualTimers();
  const detach = attachHlsVideo({}, URL_, { loadHls, ...timers });
  await flush();
  const [hls] = instances;
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
  assert.equal(timers.pending.size, 1);

  detach();
  assert.equal(timers.pending.size, 0);
  assert.equal(hls.calls.at(-1), 'destroy');
});

test('browsers without Media Source Extensions play the playlist natively', async () => {
  const { loadHls, instances } = fakeHls({ supported: false });
  const video = {};
  attachHlsVideo(video, URL_, { loadHls });
  await flush();
  assert.equal(instances.length, 0);
  assert.equal(video.src, URL_);
});
