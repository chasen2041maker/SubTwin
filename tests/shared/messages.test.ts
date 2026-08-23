import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MESSAGE_PROTOCOL,
  MESSAGE_PROTOCOL_VERSION,
  createMessage,
  parseMessageEnvelope,
  type MessageFor,
} from '../../src/shared/messages';
import { DEFAULT_SETTINGS } from '../../src/storage/schema';

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

  it('accepts only an exact credential-free translation request schema', () => {
    const request = createMessage({
      id: 'translation-1',
      source: 'content',
      type: 'translation/request',
      payload: {
        taskId: 'task-1',
        sessionId: 'session-1',
        episodeId: 'episode_hash_1',
        trackHash: 'track_hash_1',
        provider: 'deepseek',
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hans',
        episodeGeneration: 1,
        providerGeneration: 2,
        priority: 'urgent',
        cues: [{ id: 'cue-1', startMs: 0, endMs: 1_000, text: 'Hello.' }],
        context: [],
      },
    });

    expect(parseMessageEnvelope(request)).toEqual({ ok: true, value: request });
    for (const forbidden of [
      { apiKey: 'secret' },
      { Authorization: 'Bearer secret' },
      { headers: { Authorization: 'secret' } },
      { endpoint: 'https://example.test' },
      { model: 'deepseek-v4-pro' },
    ]) {
      expect(parseMessageEnvelope({
        ...request,
        payload: { ...request.payload, ...forbidden },
      }).ok).toBe(false);
    }
  });

  it('accepts only an exact content-originated translation cancellation schema', () => {
    const cancel = createMessage({
      id: 'translation-cancel-1',
      source: 'content',
      type: 'translation/cancel',
      payload: {
        sessionId: 'session-1',
        episodeGeneration: 3,
        providerGeneration: 2,
        reason: 'official-track',
      },
    });
    const acknowledgement = createMessage({
      id: 'translation-cancel-1:background',
      source: 'background',
      type: 'translation/cancelled',
      payload: {
        sessionId: 'session-1',
        episodeGeneration: 3,
        providerGeneration: 2,
        accepted: true,
      },
    });

    expect(parseMessageEnvelope(cancel)).toEqual({ ok: true, value: cancel });
    expect(parseMessageEnvelope(acknowledgement)).toEqual({
      ok: true,
      value: acknowledgement,
    });
    expect(parseMessageEnvelope({
      ...cancel,
      payload: { ...cancel.payload, apiKey: 'must-not-cross-the-boundary' },
    }).ok).toBe(false);
    expect(parseMessageEnvelope({ ...cancel, source: 'page' }).ok).toBe(false);
    expect(parseMessageEnvelope({ ...acknowledgement, source: 'content' }).ok).toBe(false);
  });

  it('accepts strict credential-free options actions and background results', () => {
    const deepseekTest = createMessage({
      id: 'settings-test-1',
      source: 'options',
      type: 'settings/deepseek-test',
      payload: {},
    });
    const cacheClear = createMessage({
      id: 'settings-cache-1',
      source: 'options',
      type: 'settings/cache-clear',
      payload: { scope: 'all' },
    });
    const deepseekResult = createMessage({
      id: 'settings-test-1:background',
      source: 'background',
      type: 'settings/deepseek-test-result',
      payload: {
        status: 'success',
        errorCode: null,
        retryable: false,
      },
    });
    const cacheResult = createMessage({
      id: 'settings-cache-1:background',
      source: 'background',
      type: 'settings/cache-clear-result',
      payload: { scope: 'all', status: 'success', errorCode: null },
    });

    for (const message of [deepseekTest, cacheClear, deepseekResult, cacheResult]) {
      expect(parseMessageEnvelope(message)).toEqual({ ok: true, value: message });
    }
    expect(parseMessageEnvelope({
      ...deepseekTest,
      payload: { apiKey: 'must-remain-in-background-storage' },
    }).ok).toBe(false);
    expect(parseMessageEnvelope({
      ...cacheClear,
      payload: { scope: 'episode', episodeId: 'private-title-id' },
    }).ok).toBe(false);
    expect(parseMessageEnvelope({ ...deepseekTest, source: 'content' }).ok).toBe(false);
  });

  it('accepts exact page-scoped settings mutations and safe popup results', () => {
    const optionsUpdate = createMessage({
      id: 'settings-update-1',
      source: 'options',
      type: 'settings/options-update',
      payload: { settings: DEFAULT_SETTINGS, updateEnabled: false },
    });
    const publicGet = createMessage({
      id: 'settings-public-1',
      source: 'popup',
      type: 'settings/public-get',
      payload: {},
    });
    const privateGet = createMessage({
      id: 'settings-private-1',
      source: 'options',
      type: 'settings/private-get',
      payload: {},
    });
    const privateResult = createMessage({
      id: 'settings-private-1:background',
      source: 'background',
      type: 'settings/private-get-result',
      payload: { settings: DEFAULT_SETTINGS },
    });
    const enabledSet = createMessage({
      id: 'settings-enabled-1',
      source: 'popup',
      type: 'settings/enabled-set',
      payload: { enabled: false },
    });
    const optionsEnabledSet = { ...enabledSet, id: 'settings-enabled-options', source: 'options' } as const;
    const safeResult = createMessage({
      id: 'settings-public-1:background',
      source: 'background',
      type: 'settings/public-get-result',
      payload: { enabled: true, provider: 'deepseek' },
    });

    for (const message of [
      optionsUpdate,
      privateGet,
      privateResult,
      publicGet,
      enabledSet,
      optionsEnabledSet,
      safeResult,
    ]) {
      expect(parseMessageEnvelope(message)).toEqual({ ok: true, value: message });
    }
    expect(parseMessageEnvelope({ ...optionsUpdate, source: 'content' }).ok).toBe(false);
    expect(parseMessageEnvelope({
      ...optionsUpdate,
      payload: {
        settings: { ...DEFAULT_SETTINGS, apiKey: 'unexpected-extra-field' },
      },
    }).ok).toBe(false);
    expect(parseMessageEnvelope({
      ...safeResult,
      payload: { ...safeResult.payload, apiKey: 'must-not-reach-popup' },
    }).ok).toBe(false);
  });

  it('snapshots translation fields before any asynchronous background work', () => {
    const candidate = {
      protocol: 'subtwin',
      version: 1,
      id: 'translation-snapshot',
      source: 'content',
      type: 'translation/request',
      payload: {
        taskId: 'task-1',
        sessionId: 'session-1',
        episodeId: 'episode_hash_1',
        trackHash: 'track_hash_1',
        provider: 'deepseek',
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hans',
        episodeGeneration: 1,
        providerGeneration: 1,
        priority: 'urgent',
        cues: [{ id: 'cue-1', startMs: 0, endMs: 1_000, text: 'Original' }],
        context: [],
      },
    };

    const parsed = parseMessageEnvelope(candidate);
    candidate.payload.cues[0]!.text = 'Mutated after validation';

    expect(parsed).toMatchObject({
      ok: true,
      value: { payload: { cues: [{ text: 'Original' }] } },
    });
  });

  it('rejects duplicate request cue IDs and inconsistent result sets', () => {
    const basePayload = {
      taskId: 'task-1',
      sessionId: 'session-1',
      episodeId: 'episode_hash_1',
      trackHash: 'track_hash_1',
      provider: 'deepseek',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      episodeGeneration: 1,
      providerGeneration: 1,
      priority: 'urgent',
      cues: [
        { id: 'cue-1', startMs: 0, endMs: 1_000, text: 'One' },
        { id: 'cue-1', startMs: 1_000, endMs: 2_000, text: 'Duplicate' },
      ],
      context: [],
    };
    expect(parseMessageEnvelope({
      protocol: 'subtwin', version: 1, id: 'duplicate', source: 'content',
      type: 'translation/request', payload: basePayload,
    }).ok).toBe(false);

    const resultBase = {
      taskId: 'task-1',
      sessionId: 'session-1',
      provider: 'deepseek',
      episodeGeneration: 1,
      providerGeneration: 1,
      status: 'success',
      translations: [{ cueId: 'cue-1', text: '译文' }],
      retryCueIds: [],
      errorCode: null,
      retryable: false,
    };
    const envelope = (payload: unknown) => ({
      protocol: 'subtwin', version: 1, id: 'result', source: 'background',
      type: 'translation/result', payload,
    });
    expect(parseMessageEnvelope(envelope({
      ...resultBase,
      translations: [...resultBase.translations, ...resultBase.translations],
    })).ok).toBe(false);
    expect(parseMessageEnvelope(envelope({
      ...resultBase,
      retryCueIds: ['cue-1'],
    })).ok).toBe(false);
    expect(parseMessageEnvelope(envelope({
      ...resultBase,
      status: 'error',
      errorCode: 'provider_unavailable',
      retryable: true,
    })).ok).toBe(false);
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
