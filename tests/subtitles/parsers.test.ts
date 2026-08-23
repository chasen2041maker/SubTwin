import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { parseTtml } from '../../src/subtitles/ttml';
import type { SubtitleTrack } from '../../src/subtitles/types';
import { parseWebVtt } from '../../src/subtitles/webvtt';

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/subtitles/${name}`, import.meta.url)),
    'utf8',
  );

const english = { tag: 'en', label: 'English', kind: 'subtitles' } as const;

describe('TTML parser', () => {
  it('normalizes namespaces, nested spans, line breaks, entities, and timing parameters', () => {
    const first = parseTtml(fixture('sample.ttml'), {
      trackId: 'official-en',
      language: english,
    });
    const second = parseTtml(fixture('sample.ttml'), {
      trackId: 'official-en',
      language: english,
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) return;

    expectTypeOf(first.value).toEqualTypeOf<SubtitleTrack>();
    expect(first.value).toMatchObject({
      id: 'official-en',
      format: 'ttml',
      language: english,
      metadata: {
        frameRate: '30',
        frameRateMultiplier: '1000 1001',
        tickRate: '100',
      },
    });
    expect(first.value.cues).toHaveLength(2);
    expect(first.value.cues[0]).toMatchObject({
      startMs: 1_000,
      endMs: 2_500,
      text: 'Alpha & beta\nGamma.',
      metadata: { sourceId: 'line-a' },
    });
    expect(first.value.cues[1]).toMatchObject({
      startMs: 3_000,
      endMs: 5_002,
      text: 'Delta < epsilon.',
    });
    expect(first.value.cues.map(({ id }) => id)).toEqual(
      second.ok ? second.value.cues.map(({ id }) => id) : [],
    );
    expect(new Set(first.value.cues.map(({ id }) => id)).size).toBe(2);
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(first.value.cues)).toBe(true);
    expect(Object.isFrozen(first.value.cues[0])).toBe(true);
  });

  it('uses the TTML default of 30fps instead of assuming 24fps', () => {
    const result = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:00:15" dur="15f">Frame sample.</p></div></body></tt>',
      { trackId: 'default-fps', language: english },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { cues: [{ startMs: 500, endMs: 1_000 }] },
    });
  });

  it('resolves child begin/end against ancestors and clips to parent duration', () => {
    const result = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body begin="1s" dur="2s"><div begin="500ms"><p begin="1s" end="4s">Bounded cue.</p></div></body></tt>',
      { trackId: 'nested-time', language: english },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { cues: [{ startMs: 2_500, endMs: 3_000 }] },
    });
  });

  it('rejects a non-integral tickRate parameter', () => {
    const result = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="1.5"><body><p begin="1t" dur="1t">Tick cue.</p></body></tt>',
      { trackId: 'bad-ticks', language: english },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_ttml_timing', retryable: false },
    });
  });

  it.each([
    ['invalid XML', '<tt><body><p></body></tt>', 'invalid_ttml'],
    [
      'invalid timing',
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="soon" end="2s">Text.</p></body></tt>',
      'invalid_ttml_timing',
    ],
  ])('returns a typed failure for %s without throwing', (_name, input, code) => {
    expect(() =>
      parseTtml(input, { trackId: 'broken', language: english }),
    ).not.toThrow();
    expect(
      parseTtml(input, { trackId: 'broken', language: english }),
    ).toMatchObject({ ok: false, error: { code, retryable: false } });
  });
});

describe('WebVTT parser', () => {
  it('normalizes cue IDs, settings, multiline text, markup, and entities', () => {
    const result = parseWebVtt(fixture('sample.vtt'), {
      trackId: 'official-en-vtt',
      language: english,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.cues).toHaveLength(2);
    expect(result.value.cues[0]).toMatchObject({
      startMs: 1_000,
      endMs: 2_500,
      text: 'Alpha & beta\nGamma !',
      settings: { line: '90%', align: 'start' },
      metadata: { sourceId: 'alpha-source' },
    });
    expect(result.value.cues[1]).toMatchObject({
      startMs: 3_000,
      endMs: 4_250,
      text: 'Delta 👋 <epsilon>.',
    });
  });

  it('accepts a header separator containing only spaces and tabs', () => {
    const result = parseWebVtt(
      'WEBVTT\n \t\n00:00.000 --> 00:01.000\nQuiet cloud.',
      { trackId: 'spaced-header', language: english },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { cues: [{ startMs: 0, endMs: 1_000, text: 'Quiet cloud.' }] },
    });
  });

  it('preserves repeated source cue identifiers while generating unique cue IDs', () => {
    const result = parseWebVtt(
      'WEBVTT\n\nrepeat\n00:00.000 --> 00:01.000\nFirst leaf.\n\nrepeat\n00:01.000 --> 00:02.000\nSecond leaf.',
      { trackId: 'repeated-source-id', language: english },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.cues.map(({ metadata }) => metadata?.sourceId)).toEqual([
      'repeat',
      'repeat',
    ]);
    expect(new Set(result.value.cues.map(({ id }) => id)).size).toBe(2);
  });

  it.each([
    ['a missing header', '00:00.000 --> 00:01.000\nText.', 'invalid_webvtt'],
    [
      'a malformed timestamp',
      'WEBVTT\n\n00:70.000 --> 00:71.000\nText.',
      'invalid_webvtt_timing',
    ],
    [
      'a reversed interval',
      'WEBVTT\n\n00:02.000 --> 00:01.000\nText.',
      'invalid_webvtt_timing',
    ],
  ])('returns a typed failure for %s', (_name, input, code) => {
    expect(() =>
      parseWebVtt(input, { trackId: 'broken', language: english }),
    ).not.toThrow();
    expect(
      parseWebVtt(input, { trackId: 'broken', language: english }),
    ).toMatchObject({ ok: false, error: { code, retryable: false } });
  });
});
