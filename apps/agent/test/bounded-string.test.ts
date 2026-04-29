import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoundedString } from '../src/core/bounded-string.js';

test('BoundedString returns the body unchanged when under cap', () => {
  const buf = new BoundedString(1024);
  buf.append('hello ');
  buf.append('world');
  assert.equal(buf.finalize(), 'hello world');
  assert.equal(buf.wasTruncated(), false);
});

test('BoundedString truncates and appends a marker once cap is hit', () => {
  const buf = new BoundedString(8, 'stdout');
  buf.append('1234567890'); // 10 bytes, cap is 8
  const out = buf.finalize();
  assert.ok(out.startsWith('12345678'), `got: ${out}`);
  assert.match(out, /\[truncated: stdout exceeded 8B cap; dropped 2B\]/);
  assert.equal(buf.wasTruncated(), true);
});

test('BoundedString counts dropped bytes across follow-up chunks', () => {
  const buf = new BoundedString(4, 'stderr');
  buf.append('abcdef'); // 6 bytes -> first 4 kept, 2 dropped
  buf.append('ghi');     // 3 more bytes dropped
  const out = buf.finalize();
  assert.match(out, /\[truncated: stderr exceeded 4B cap; dropped 5B\]/);
});

test('BoundedString does not split a multi-byte UTF-8 codepoint', () => {
  // '中' is 3 UTF-8 bytes (E4 B8 AD). Cap of 4 should keep the first
  // codepoint and drop the rest, not produce a truncated 1-byte sequence
  // that would render as a replacement char.
  const buf = new BoundedString(4);
  buf.append('中文'); // 6 bytes total
  const out = buf.finalize();
  // Body should be the complete '中' (3 bytes) — no partial follow-up byte.
  const body = out.split('\n[truncated:')[0]!;
  assert.equal(body, '中');
});

test('BoundedString tolerates a chunk that exactly fills the cap', () => {
  const buf = new BoundedString(5);
  buf.append('hello');
  assert.equal(buf.finalize(), 'hello');
  assert.equal(buf.wasTruncated(), false);
});
