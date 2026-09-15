import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_HEIGHT_MAX_AGE_MS,
  CAMERA_HEIGHT_MIN_INTERVAL_MS,
  TILESET_COLLISION_CEILING_M,
  throttleCameraGroundHeight,
} from './sceneHeightThrottle.js';

function fakeScene() {
  const calls = [];
  const scene = {
    getHeight(cartographic, heightReference) {
      calls.push({ cartographic, heightReference, self: this });
      return 100 + calls.length;
    },
  };
  return { scene, calls };
}

const JAKARTA = { longitude: 106.8456 * Math.PI / 180, latitude: -6.2088 * Math.PI / 180, height: 1500 };
const offsetEastM = (carto, metres) => ({ ...carto, longitude: carto.longitude + metres / (6371008.8 * Math.cos(carto.latitude)) });

test('a camera holding still reuses its ground height until the value is a second old', () => {
  const { scene, calls } = fakeScene();
  let clock = 0;
  throttleCameraGroundHeight(scene, { now: () => clock });

  assert.equal(scene.getHeight(JAKARTA), 101);
  clock = 500;
  assert.equal(scene.getHeight(offsetEastM(JAKARTA, 2)), 101, 'within 5 m reuses');
  assert.equal(calls.length, 1);
  clock = CAMERA_HEIGHT_MAX_AGE_MS;
  assert.equal(scene.getHeight(JAKARTA), 102, 'a stale value is re-read');
  assert.equal(calls[0].self, scene, 'Cesium sees the scene as `this`');
});

test('a moving camera re-reads at most every 100 ms', () => {
  const { scene, calls } = fakeScene();
  let clock = 0;
  throttleCameraGroundHeight(scene, { now: () => clock });

  scene.getHeight(JAKARTA);
  clock = CAMERA_HEIGHT_MIN_INTERVAL_MS - 1;
  scene.getHeight(offsetEastM(JAKARTA, 400));
  assert.equal(calls.length, 1, 'fast motion inside the interval reuses');
  clock = CAMERA_HEIGHT_MIN_INTERVAL_MS;
  scene.getHeight(offsetEastM(JAKARTA, 800));
  assert.equal(calls.length, 2);
});

test('queries with a height reference always reach Cesium', () => {
  const { scene, calls } = fakeScene();
  throttleCameraGroundHeight(scene, { now: () => 0 });
  const CLAMP_TO_GROUND = 1;
  scene.getHeight(JAKARTA);
  scene.getHeight(JAKARTA, CLAMP_TO_GROUND);
  scene.getHeight(JAKARTA, CLAMP_TO_GROUND);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].heightReference, CLAMP_TO_GROUND);
});

test('a camera above the structure ceiling asks terrain alone, every time', () => {
  const { scene, calls } = fakeScene();
  const CLAMP_TO_TERRAIN = 3;
  throttleCameraGroundHeight(scene, { now: () => 0, terrainOnlyReference: CLAMP_TO_TERRAIN });
  const high = { ...JAKARTA, height: TILESET_COLLISION_CEILING_M + 1 };
  scene.getHeight(high);
  scene.getHeight(high);
  assert.deepEqual(calls.map((call) => call.heightReference), [CLAMP_TO_TERRAIN, CLAMP_TO_TERRAIN]);

  scene.getHeight(JAKARTA);
  assert.equal(calls.at(-1).heightReference, undefined, 'below the ceiling the full query returns');
});

test('wrapping twice is a no-op and the restore puts the original back', () => {
  const { scene } = fakeScene();
  const original = scene.getHeight;
  const restore = throttleCameraGroundHeight(scene, { now: () => 0 });
  const wrapped = scene.getHeight;
  throttleCameraGroundHeight(scene, { now: () => 0 });
  assert.equal(scene.getHeight, wrapped);
  restore();
  assert.equal(scene.getHeight, original);
});
