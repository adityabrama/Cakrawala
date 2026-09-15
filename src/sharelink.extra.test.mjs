import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager, readShareExtraParam } from './sharelink.js';

function makeManager(hash = '') {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, nextHash) {
      window.location.hash = nextHash;
    },
  };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

test('an extra-state provider writes its allowlisted token and nothing else', () => {
  const manager = makeManager();
  manager.setExtraStateProvider('idn', () => 'm.1_p.32_g.1');
  const params = manager._buildHashParams();
  assert.equal(params.get('idn'), 'm.1_p.32_g.1');
  assert.equal(params.get('v'), '2', 'existing fields are untouched');
});

test('a provider that returns null, throws, or emits an unsafe value leaves the field out', () => {
  const manager = makeManager();
  manager.setExtraStateProvider('idn', () => null);
  assert.equal(manager._buildHashParams().has('idn'), false);
  manager.setExtraStateProvider('idn', () => { throw new Error('boom'); });
  assert.equal(manager._buildHashParams().has('idn'), false);
  manager.setExtraStateProvider('idn', () => 'm.1&lat=99');
  assert.equal(manager._buildHashParams().has('idn'), false, 'a delimiter can never enter the hash');
  manager.setExtraStateProvider('idn', () => 'x'.repeat(81));
  assert.equal(manager._buildHashParams().has('idn'), false, 'oversized tokens are dropped');
});

test('provider names are allowlisted and a non-function removes the provider', () => {
  const manager = makeManager();
  manager.setExtraStateProvider('LAT', () => 'evil');
  manager.setExtraStateProvider('lat', () => '99');
  assert.equal(manager._buildHashParams().has('LAT'), false);
  assert.equal(manager._buildHashParams().get('lat'), '0.0000', 'a two-letter core field name is still reserved by the core writer order');
  manager.setExtraStateProvider('idn', () => 'm.1');
  manager.setExtraStateProvider('idn', null);
  assert.equal(manager._buildHashParams().has('idn'), false);
});

test('readShareExtraParam decodes only well-formed values from a hash', () => {
  assert.equal(readShareExtraParam('idn', '#lat=1&lon=2&idn=m.1_p.32'), 'm.1_p.32');
  assert.equal(readShareExtraParam('idn', 'lat=1&idn=m.0'), 'm.0');
  assert.equal(readShareExtraParam('idn', '#lat=1&lon=2'), null);
  assert.equal(readShareExtraParam('idn', '#idn=m.1%26lat%3D9'), null, 'decoded delimiters are rejected');
  assert.equal(readShareExtraParam('IDN', '#IDN=m.1'), null);
});
