import { describe, expect, it } from 'vitest';

import {
  MAX_NETFLIX_BRIDGE_BYTES,
  NETFLIX_BRIDGE_PROTOCOL,
  NETFLIX_BRIDGE_SOURCE,
  createEarlyBridgeQueue,
  createNetflixBridgeEnvelope,
  parseNetflixBridgeEvent,
  type NetflixBridgePayload,
} from '../../src/netflix/bridge';

const NONCE = 'session-nonce-0123456789';
const WINDOW_SOURCE = {};

const timedText: NetflixBridgePayload = {
  type: 'timed-text',
  titleId: 'title-1',
  resourceId: 'tt_0123456789abcdef',
  trackId: 'en-main',
  language: 'en',
  format: 'webvtt',
  body: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello',
};

describe('Netflix MAIN-world bridge', () => {
  it('round-trips the exact v1 envelope from the Netflix page', () => {
    const created = createNetflixBridgeEnvelope({
      nonce: NONCE,
      generation: 4,
      payload: timedText,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.value).toEqual({
      protocol: NETFLIX_BRIDGE_PROTOCOL,
      version: 1,
      source: NETFLIX_BRIDGE_SOURCE,
      nonce: NONCE,
      generation: 4,
      payload: timedText,
    });

    expect(
      parseNetflixBridgeEvent(
        {
          origin: 'https://www.netflix.com',
          source: WINDOW_SOURCE,
          data: created.value,
        },
        { nonce: NONCE, generation: 4, source: WINDOW_SOURCE },
      ),
    ).toEqual({ ok: true, value: created.value });
  });

  it.each([
    ['origin', { origin: 'https://evil.example', source: WINDOW_SOURCE }],
    ['source', { origin: 'https://www.netflix.com', source: {} }],
  ])('rejects the wrong event %s', (_name, event) => {
    const created = createNetflixBridgeEnvelope({
      nonce: NONCE,
      generation: 4,
      payload: timedText,
    });
    if (!created.ok) throw new Error('test setup failed');

    const result = parseNetflixBridgeEvent(
      { ...event, data: created.value },
      { nonce: NONCE, generation: 4, source: WINDOW_SOURCE },
    );

    expect(result.ok).toBe(false);
  });

  it('rejects wrong sessions, old generations, extra fields, and sensitive shapes', () => {
    const base = {
      protocol: NETFLIX_BRIDGE_PROTOCOL,
      version: 1,
      source: NETFLIX_BRIDGE_SOURCE,
      nonce: NONCE,
      generation: 4,
      payload: timedText,
    };
    const parse = (data: unknown) =>
      parseNetflixBridgeEvent(
        {
          origin: 'https://www.netflix.com',
          source: WINDOW_SOURCE,
          data,
        },
        { nonce: NONCE, generation: 4, source: WINDOW_SOURCE },
      );

    expect(parse({ ...base, nonce: 'another-session-012345' }).ok).toBe(false);
    expect(parse({ ...base, generation: 3 }).ok).toBe(false);
    expect(parse({ ...base, rawUrl: 'https://example.test/?token=secret' }).ok).toBe(false);
    expect(
      parse({
        ...base,
        payload: { ...timedText, headers: { cookie: 'secret' } },
      }).ok,
    ).toBe(false);
    expect(
      parse({
        ...base,
        payload: { type: 'media', drm: 'widevine', body: 'bytes' },
      }).ok,
    ).toBe(false);
    const { titleId: _missingTitleId, ...unboundTimedText } = timedText;
    expect(parse({ ...base, payload: unboundTimedText }).ok).toBe(false);
    expect(
      parse({
        ...base,
        payload: { ...timedText, titleId: '../unsafe-title' },
      }).ok,
    ).toBe(false);
  });

  it('enforces both the timed-text body and serialized-envelope 10 MiB bounds', () => {
    const oversizedBody = 'x'.repeat(MAX_NETFLIX_BRIDGE_BYTES + 1);
    const bodyResult = createNetflixBridgeEnvelope({
      nonce: NONCE,
      generation: 1,
      payload: { ...timedText, body: oversizedBody },
    });
    expect(bodyResult.ok).toBe(false);

    const envelopeResult = createNetflixBridgeEnvelope(
      {
        nonce: NONCE,
        generation: 1,
        payload: timedText,
      },
      { maxEnvelopeBytes: 64 },
    );
    expect(envelopeResult.ok).toBe(false);
  });

  it('buffers only a bounded sanitized prefix, then ignores stale/disposed events', () => {
    const queue = createEarlyBridgeQueue({
      nonce: NONCE,
      generation: 2,
      capacity: 2,
    });
    const diagnostic = (code: 'candidate_rejected' | 'display_unavailable') =>
      ({ type: 'diagnostic', code }) as const;

    expect(queue.publish(diagnostic('candidate_rejected'), 2)).toBe(true);
    expect(queue.publish(diagnostic('display_unavailable'), 2)).toBe(true);
    expect(queue.publish(timedText, 2)).toBe(true);
    expect(queue.publish({ type: 'timed-text', rawUrl: 'secret' }, 2)).toBe(false);
    expect(queue.size).toBe(2);

    const received: NetflixBridgePayload[] = [];
    queue.attach((message) => received.push(message.payload));
    expect(received).toEqual([diagnostic('display_unavailable'), timedText]);

    queue.nextGeneration(3, 'session-nonce-9876543210');
    expect(queue.publish(timedText, 2)).toBe(false);
    queue.dispose();
    expect(queue.publish(timedText, 3)).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('snapshots sanitized payloads before buffering them', () => {
    const queue = createEarlyBridgeQueue({
      nonce: NONCE,
      generation: 1,
      capacity: 1,
    });
    const callerOwned: Record<string, unknown> = {
      type: 'diagnostic',
      code: 'candidate_rejected',
    };

    expect(queue.publish(callerOwned)).toBe(true);
    callerOwned.code = 'unsupported_payload';
    callerOwned.rawUrl = 'https://cdn.nflxvideo.net/?token=secret';

    const received: NetflixBridgePayload[] = [];
    queue.attach((message) => received.push(message.payload));
    expect(received).toEqual([
      { type: 'diagnostic', code: 'candidate_rejected' },
    ]);
  });
});
