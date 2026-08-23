import { describe, expect, it } from 'vitest';

import { MAX_NETFLIX_BRIDGE_BYTES } from '../../src/netflix/bridge';
import { parseNetflixTimedTextPayload } from '../../src/netflix/ingest';

describe('isolated-world timed-text ingestion', () => {
  it('delegates validated WebVTT to the subtitle domain and returns a normalized track', () => {
    const result = parseNetflixTimedTextPayload(
      {
        type: 'timed-text',
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        language: 'en-US',
        format: 'webvtt',
        body: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello world',
      },
      {
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        languageTag: 'en-US',
        kind: 'subtitle',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      id: 'en-main',
      format: 'webvtt',
      language: { tag: 'en', kind: 'subtitles' },
      cues: [{ startMs: 0, endMs: 1_000, text: 'Hello world' }],
    });
  });

  it('delegates TTML and rejects a mismatched resource without echoing secrets', () => {
    const ttml = parseNetflixTimedTextPayload(
      {
        type: 'timed-text',
        titleId: 'title-1',
        resourceId: 'tt_1111111111111111',
        trackId: 'zh-main',
        language: 'zh-CN',
        format: 'ttml',
        body: '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="1s">你好</p></div></body></tt>',
      },
      {
        titleId: 'title-1',
        resourceId: 'tt_1111111111111111',
        trackId: 'zh-main',
        languageTag: 'zh-CN',
        kind: 'closed-caption',
      },
    );
    expect(ttml.ok && ttml.value.language).toMatchObject({
      tag: 'zh-Hans',
      kind: 'captions',
    });

    const mismatch = parseNetflixTimedTextPayload(
      {
        type: 'timed-text',
        titleId: 'title-1',
        resourceId: 'tt_2222222222222222',
        trackId: 'en-main',
        language: 'en',
        format: 'webvtt',
        body: 'WEBVTT\n\nsecret subtitle',
      },
      {
        titleId: 'title-1',
        resourceId: 'tt_3333333333333333',
        trackId: 'en-main',
        languageTag: 'en',
        kind: 'subtitle',
      },
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: 'netflix_timed_text_identity_mismatch' },
    });
    expect(JSON.stringify(mismatch)).not.toContain('secret subtitle');
  });

  it('rejects mismatched track metadata before parsing the body', () => {
    const mismatch = parseNetflixTimedTextPayload(
      {
        type: 'timed-text',
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'zh-main',
        language: 'zh-CN',
        format: 'webvtt',
        body: 'WEBVTT\n\nprivate subtitle text',
      },
      {
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        languageTag: 'en-US',
        kind: 'subtitle',
      },
    );

    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: 'netflix_timed_text_identity_mismatch' },
    });
    expect(JSON.stringify(mismatch)).not.toContain('private subtitle text');
  });

  it('rejects a body bound to another title before parsing it', () => {
    const mismatch = parseNetflixTimedTextPayload(
      {
        type: 'timed-text',
        titleId: 'preview-title',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        language: 'en',
        format: 'webvtt',
        body: 'WEBVTT\n\nprivate cross-title subtitle',
      },
      {
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        languageTag: 'en',
        kind: 'subtitle',
      },
    );

    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: 'netflix_timed_text_identity_mismatch' },
    });
    expect(JSON.stringify(mismatch)).not.toContain('private cross-title subtitle');
  });

  it('rejects direct payloads above the bridge byte limit', () => {
    const result = parseNetflixTimedTextPayload(
      {
        type: 'timed-text',
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        language: 'en',
        format: 'webvtt',
        body: 'x'.repeat(MAX_NETFLIX_BRIDGE_BYTES + 1),
      },
      {
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        languageTag: 'en',
        kind: 'subtitle',
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'netflix_invalid_timed_text_payload' },
    });
  });
});
