import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from './queryParser';

test('exact duration M:SS', () => {
  const r = parseQuery('3:16');
  assert.equal(r.exactDuration, 196000);
  assert.equal(r.exactDurationWindowMs, 1000);
  assert.equal(r.keywords, undefined);
});

test('millisecond precision', () => {
  const r = parseQuery('3:16.423');
  assert.equal(r.exactDuration, 196423);
  assert.equal(r.exactDurationWindowMs, 1); // 3 ms digits → 1ms window
});

test('range "X to Y"', () => {
  const r = parseQuery('3:00 to 4:00');
  assert.equal(r.minDuration, 180000);
  assert.equal(r.maxDuration, 240999); // inclusive of the 4:00 second-window
});

test('range "between X and Y"', () => {
  const r = parseQuery('between 3:00 and 4:00');
  assert.equal(r.minDuration, 180000);
  assert.equal(r.maxDuration, 240999);
});

test('open-ended longer-than', () => {
  const r = parseQuery('>10:00');
  assert.equal(r.minDuration, 600000);
  assert.equal(r.maxDuration, undefined);
});

test('open-ended shorter-than', () => {
  const r = parseQuery('<3:00');
  assert.equal(r.maxDuration, 179999); // excludes the 3:00 window itself
  assert.equal(r.minDuration, undefined);
});

test('keyword + time combined', () => {
  const r = parseQuery('love 4:20');
  assert.equal(r.keywords, 'love');
  assert.equal(r.exactDuration, 260000);
});

test('keywords only', () => {
  const r = parseQuery('pink floyd');
  assert.equal(r.keywords, 'pink floyd');
  assert.equal(r.exactDuration, undefined);
  assert.equal(r.minDuration, undefined);
});

test('wildcard tokens are extracted, not treated as keywords', () => {
  assert.equal(parseQuery('con*').wildcardToken, 'con*');
  assert.equal(parseQuery('con*').keywords, undefined);
  assert.equal(parseQuery('*tion').wildcardToken, '*tion');
  assert.equal(parseQuery('*con*').wildcardToken, '*con*');
});

test('empty input', () => {
  assert.equal(parseQuery('').isEmpty, true);
  assert.equal(parseQuery('   ').isEmpty, true);
});

// Regression: ">10" with no colon must NOT be read as a duration (it was matching
// the text "10" in recording dates). It should fall through to a keyword.
test('regression: ">10" without a colon is a keyword, not a duration', () => {
  const r = parseQuery('>10');
  assert.equal(r.keywords, '>10');
  assert.equal(r.exactDuration, undefined);
  assert.equal(r.minDuration, undefined);
  assert.equal(r.maxDuration, undefined);
});
