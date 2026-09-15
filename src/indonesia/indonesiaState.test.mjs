import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createIndonesiaState, filterEventsForView, selectedEventTypes, timelineWindow, EVENT_TYPE_GROUPS, TIMELINE_PRESETS } from './indonesiaState.js';

const NOW = Date.parse('2026-09-15T06:00:00Z');
const event = (id, overrides = {}) => ({ id, type: 'earthquake', timestamp: new Date(NOW - 3_600_000).toISOString(), location: { lat: -6.2, lon: 106.8 }, provinceCode: '31', severity: 'medium', ...overrides });

test('state store merges patches, notifies changed keys, and ignores unknown fields', () => {
  const state = createIndonesiaState({ persist: false });
  const seen = [];
  state.subscribe((_, changed) => seen.push(changed));
  state.set({ enabled: true, bogus: 1 });
  state.set({ enabled: true });
  state.set({ typeGroups: ['earthquake'], timelineHours: 24 });
  assert.deepEqual(seen, [['enabled'], ['typeGroups', 'timelineHours']]);
  assert.equal(state.get().enabled, true);
  assert.equal('bogus' in state.get(), false);
  assert.ok(TIMELINE_PRESETS.some((preset) => preset.hours === 72), 'the default 72 h window has a preset chip');
});

test('filters honour type groups, timeline window (with forecast grace), and province', () => {
  const state = createIndonesiaState({ persist: false });
  state.set({ timelineHours: 24, typeGroups: EVENT_TYPE_GROUPS.map((group) => group.id) });
  const events = [
    event('recent'),
    event('old', { timestamp: new Date(NOW - 30 * 3_600_000).toISOString() }),
    event('forecast', { type: 'weather', timestamp: new Date(NOW + 3 * 3_600_000).toISOString() }),
    event('far-forecast', { type: 'weather', timestamp: new Date(NOW + 9 * 3_600_000).toISOString() }),
    event('elsewhere', { provinceCode: '32' }),
    event('nowhere', { location: null }),
  ];
  assert.deepEqual(filterEventsForView(events, state.get(), { nowMs: NOW }).map((entry) => entry.id), ['recent', 'forecast', 'elsewhere', 'nowhere']);
  assert.deepEqual(filterEventsForView(events, state.get(), { nowMs: NOW, locatedOnly: true }).map((entry) => entry.id), ['recent', 'forecast', 'elsewhere']);
  state.set({ provinceCode: '31' });
  assert.deepEqual(filterEventsForView(events, state.get(), { nowMs: NOW }).map((entry) => entry.id), ['recent', 'forecast', 'nowhere']);
  state.set({ provinceCode: null, typeGroups: ['weather'] });
  assert.deepEqual(filterEventsForView(events, state.get(), { nowMs: NOW }).map((entry) => entry.id), ['forecast']);
  assert.ok(selectedEventTypes(state.get()).has('drought'));
  state.set({ timelineUntilMs: NOW - 12 * 3_600_000, typeGroups: ['earthquake'] });
  assert.deepEqual(timelineWindow(state.get(), NOW), [NOW - 36 * 3_600_000, NOW - 12 * 3_600_000]);
  assert.deepEqual(filterEventsForView(events, state.get(), { nowMs: NOW }).map((entry) => entry.id), ['old'], 'a scrubbed cursor shows what was current then');
});
