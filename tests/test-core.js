const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const SlicerCore = require('../slicer-core');

// ── fmtB ──────────────────────────────────────────────────────

describe('fmtB', () => {
  it('returns "0 B" for zero', () => {
    assert.equal(SlicerCore.fmtB(0), '0 B');
  });

  it('returns "0 B" for falsy values', () => {
    assert.equal(SlicerCore.fmtB(null), '0 B');
    assert.equal(SlicerCore.fmtB(undefined), '0 B');
    assert.equal(SlicerCore.fmtB(''), '0 B');
  });

  it('formats values under 1 KB as bytes', () => {
    assert.equal(SlicerCore.fmtB(1), '1 B');
    assert.equal(SlicerCore.fmtB(512), '512 B');
    assert.equal(SlicerCore.fmtB(1023), '1023 B');
  });

  it('formats values in KB range', () => {
    assert.equal(SlicerCore.fmtB(1024), '1.00 KB');
    assert.equal(SlicerCore.fmtB(2048), '2.00 KB');
    assert.equal(SlicerCore.fmtB(5120), '5.00 KB');
  });

  it('uses 1 decimal for values >= 10 KB', () => {
    assert.equal(SlicerCore.fmtB(10240), '10.0 KB');
    assert.equal(SlicerCore.fmtB(102400), '100.0 KB');
  });

  it('formats values in MB range', () => {
    assert.equal(SlicerCore.fmtB(1048576), '1.00 MB');
    assert.equal(SlicerCore.fmtB(2097152), '2.00 MB');
    assert.equal(SlicerCore.fmtB(5242880), '5.00 MB');
  });
});

// ── getLine ───────────────────────────────────────────────────

describe('getLine', () => {
  it('returns the line at the given char index', () => {
    assert.equal(SlicerCore.getLine(0, 'hello\nworld'), 'hello');
    assert.equal(SlicerCore.getLine(3, 'hello\nworld'), 'hello');
    assert.equal(SlicerCore.getLine(6, 'hello\nworld'), 'world');
  });

  it('returns empty string for a blank line', () => {
    assert.equal(SlicerCore.getLine(6, 'hello\n\nworld'), '');
  });

  it('handles single-line text', () => {
    assert.equal(SlicerCore.getLine(0, 'hello'), 'hello');
    assert.equal(SlicerCore.getLine(4, 'hello'), 'hello');
  });

  it('handles index at newline character', () => {
    assert.equal(SlicerCore.getLine(5, 'hello\nworld'), 'hello');
  });
});

// ── isOnBlankLine ─────────────────────────────────────────────

describe('isOnBlankLine', () => {
  it('returns false for empty text', () => {
    assert.equal(SlicerCore.isOnBlankLine(0, ''), false);
  });

  it('returns false for negative index', () => {
    assert.equal(SlicerCore.isOnBlankLine(-1, 'hello'), false);
  });

  it('returns true for index at text length', () => {
    assert.equal(SlicerCore.isOnBlankLine(5, 'hello'), true);
  });

  it('returns true for index beyond text length', () => {
    assert.equal(SlicerCore.isOnBlankLine(100, 'hello'), true);
  });

  it('returns true on a blank line', () => {
    assert.equal(SlicerCore.isOnBlankLine(6, 'hello\n\nworld'), true);
  });

  it('returns false on a non-blank line with no adjacent blank', () => {
    assert.equal(SlicerCore.isOnBlankLine(0, 'hello\nworld'), false);
  });

  it('returns true when the next line is blank', () => {
    assert.equal(SlicerCore.isOnBlankLine(4, 'hello\n\nworld'), true);
  });

  it('returns false for null/undefined text', () => {
    assert.equal(SlicerCore.isOnBlankLine(0, null), false);
    assert.equal(SlicerCore.isOnBlankLine(0, undefined), false);
  });

  it('handles whitespace-only blank lines', () => {
    assert.equal(SlicerCore.isOnBlankLine(6, 'hello\n   \nworld'), true);
  });
});

// ── transformContent ──────────────────────────────────────────

describe('transformContent', () => {
  const i18n = {
    trigger: 'TRIGGER_LINE',
    replacementBase: 'REPLACEMENT_BASE',
    formatReportIntro: (count) => `divided into ${count} parts`,
    formatReportHeader: (n) => `[Report ${n}]`
  };

  it('replaces trigger in first chunk with intro + header', () => {
    const result = SlicerCore.transformContent(
      'before TRIGGER_LINE after', 0, 3, i18n
    );
    assert.ok(result.includes('REPLACEMENT_BASE'));
    assert.ok(result.includes('divided into 3 parts'));
    assert.ok(result.includes('[Report 1]'));
    assert.ok(!result.includes('TRIGGER_LINE'));
    assert.ok(result.includes('before'));
    assert.ok(result.includes('after'));
  });

  it('adds report header to non-first chunks', () => {
    const result = SlicerCore.transformContent('some content', 1, 3, i18n);
    assert.ok(result.startsWith('[Report 2]\n'));
    assert.ok(result.includes('some content'));
  });

  it('adds header when first chunk has no trigger', () => {
    const result = SlicerCore.transformContent('no trigger here', 0, 3, i18n);
    assert.ok(result.startsWith('[Report 1]\n'));
  });

  it('passes correct chunk number for later chunks', () => {
    const r3 = SlicerCore.transformContent('c3', 2, 5, i18n);
    assert.ok(r3.startsWith('[Report 3]\n'));
    const r5 = SlicerCore.transformContent('c5', 4, 5, i18n);
    assert.ok(r5.startsWith('[Report 5]\n'));
  });

  it('replaces only the first occurrence of trigger', () => {
    const result = SlicerCore.transformContent(
      'TRIGGER_LINE middle TRIGGER_LINE end', 0, 2, i18n
    );
    assert.ok(result.includes('REPLACEMENT_BASE'));
    assert.ok(result.includes('TRIGGER_LINE'));
  });
});

// ── getSegments ───────────────────────────────────────────────

describe('getSegments', () => {
  const { TextEncoder } = require('util');
  const enc = new TextEncoder();

  it('returns empty array for empty text', () => {
    const segs = SlicerCore.getSegments('', [], 0, enc);
    assert.equal(segs.length, 0);
  });

  it('returns one segment with no cuts', () => {
    const text = 'hello world';
    const segs = SlicerCore.getSegments(text, [], text.length, enc);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].content, 'hello world');
    assert.equal(segs[0].chars, 11);
    assert.equal(segs[0].bytes, enc.encode(text).length);
    assert.equal(segs[0].colorIdx, 0);
  });

  it('returns two segments with one cut', () => {
    const text = 'hello world';
    const segs = SlicerCore.getSegments(text, [5], text.length, enc);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].content, 'hello');
    assert.equal(segs[0].chars, 5);
    assert.equal(segs[1].content, ' world');
    assert.equal(segs[1].chars, 6);
  });

  it('returns correct number of segments with multiple cuts', () => {
    const text = 'aaa bbb ccc';
    const segs = SlicerCore.getSegments(text, [3, 7], text.length, enc);
    assert.equal(segs.length, 3);
    assert.equal(segs[0].content, 'aaa');
    assert.equal(segs[1].content, ' bbb');
    assert.equal(segs[2].content, ' ccc');
  });

  it('filters out zero-char segments', () => {
    const text = 'abc';
    const segs = SlicerCore.getSegments(text, [0], 3, enc);
    assert.ok(segs.every(s => s.chars > 0));
  });

  it('handles activeBottomChar less than last cut', () => {
    const text = 'hello world';
    const segs = SlicerCore.getSegments(text, [5], 3, enc);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].content, 'hello');
  });

  it('computes correct byte counts for multi-byte characters', () => {
    const text = 'こんにちは';
    const segs = SlicerCore.getSegments(text, [], text.length, enc);
    assert.equal(segs[0].bytes, enc.encode(text).length);
    assert.equal(segs[0].bytes, 15);
  });

  it('assigns sequential colorIdx values', () => {
    const text = 'abcdefghij';
    const segs = SlicerCore.getSegments(text, [3, 6], text.length, enc);
    assert.equal(segs[0].colorIdx, 0);
    assert.equal(segs[1].colorIdx, 1);
    assert.equal(segs[2].colorIdx, 2);
  });
});
