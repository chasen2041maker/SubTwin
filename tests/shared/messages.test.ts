import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MESSAGE_PROTOCOL,
  MESSAGE_PROTOCOL_VERSION,
  createMessage,
  parseMessageEnvelope,
  type MessageFor,
} from '../../src/shared/messages';

describe('cross-context message envelopes', () => {
  it('creates a versioned, type-safe health-check request', () => {
    const message = createMessage({
      id: 'request-1',
      source: 'popup',
      type: 'system/health-check',
      payload: { sentAt: 1_725_000_000_000 },
    });

    expect(message).toEqual({
      protocol: MESSAGE_PROTOCOL,
      version: MESSAGE_PROTOCOL_VERSION,
      id: 'request-1',
      source: 'popup',
      type: 'system/health-check',
      payload: { sentAt: 1_725_000_000_000 },
    });
    expectTypeOf(message).toEqualTypeOf<
      MessageFor<'system/health-check'>
    >();
  });

  it('parses a valid health response from an unknown boundary value', () => {
    const input: unknown = {
      protocol: 'subtwin',
      version: 1,
      id: 'response-1',
      source: 'background',
      type: 'system/health-response',
      payload: { requestId: 'request-1', ready: true },
    };

    const result = parseMessageEnvelope(input);

    expect(result).toEqual({ ok: true, value: input });
  });

  it('parses only sanitized Netflix probe status and catalog summaries', () => {
    const status = createMessage({
      id: 'probe-1',
      source: 'content',
      type: 'netflix/probe-status',
      payload: {
        sessionId: 'nfs_0123456789abcdef',
        generation: 7,
        status: 'connected',
      },
    });
    const catalog = createMessage({
      id: 'catalog-1',
      source: 'content',
      type: 'netflix/catalog-summary',
      payload: {
        sessionId: 'nfs_0123456789abcdef',
        generation: 7,
        authority: 'provisional',
        tracks: [
          { id: 'en-main', language: 'en-US', kind: 'subtitle' },
        ],
      },
    });

    expect(parseMessageEnvelope(status)).toEqual({ ok: true, value: status });
    expect(parseMessageEnvelope(catalog)).toEqual({ ok: true, value: catalog });
    expect(
      parseMessageEnvelope({
        ...catalog,
        payload: {
          ...catalog.payload,
          tracks: [
            {
              ...catalog.payload.tracks[0],
              rawUrl: 'https://example.test/?token=secret',
            },
          ],
        },
      }).ok,
    ).toBe(false);
  });

  it('returns a typed error for an unsupported protocol version', () => {
    const result = parseMessageEnvelope({
      protocol: 'subtwin',
      version: 2,
      id: 'request-1',
      source: 'popup',
      type: 'system/health-check',
      payload: { sentAt: 1_725_000_000_000 },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'unsupported_message_version',
        message: 'Unsupported SubTwin message protocol version.',
        retryable: false,
        details: { receivedVersion: 2, supportedVersion: 1 },
      },
    });
  });

  it.each([
    null,
    [],
    {
      protocol: 'subtwin',
      version: 1,
      id: '',
      source: 'popup',
      type: 'system/health-check',
      payload: { sentAt: 1_725_000_000_000 },
    },
    {
      protocol: 'subtwin',
      version: 1,
      id: 'request-1',
      source: 'page',
      type: 'system/health-check',
      payload: { sentAt: Number.NaN },
    },
    {
      protocol: 'subtwin',
      version: 1,
      id: 'request-1',
      source: 'page',
      type: 'unknown/message',
      payload: {},
    },
  ])('rejects a malformed boundary value without throwing', (input) => {
    const result = parseMessageEnvelope(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_message');
      expect(result.error.retryable).toBe(false);
    }
  });
});
