import { describe, expect, it } from 'vitest';

import type { TranslationRequest } from '../../src/translation/types';
import {
  validateDeepSeekPayload,
  validateGoogleFreePayload,
} from '../../src/translation/validate';

function request(text: string): TranslationRequest {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    episodeId: 'episode-1',
    trackHash: 'track-1',
    provider: 'deepseek',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans',
    episodeGeneration: 1,
    providerGeneration: 1,
    cues: [{ id: 'cue-1', startMs: 0, endMs: 1_000, text }],
    context: [],
  };
}

describe('translation pass-through validation', () => {
  it.each(['Netflix', 'FBI', 'NASA', '2024', '@Netflix']) (
    'accepts %s when a provider correctly preserves it',
    (source) => {
      expect(validateGoogleFreePayload(source, 'cue-1', [[source]])).toEqual({
        ok: true,
        value: {
          translations: [{ cueId: 'cue-1', text: source }],
          retryCueIds: [],
        },
      });
      expect(validateDeepSeekPayload(request(source), {
        translations: [{ id: 'cue-1', text: source }],
      })).toEqual({
        ok: true,
        value: {
          translations: [{ cueId: 'cue-1', text: source }],
          retryCueIds: [],
        },
      });
    },
  );

  it('keeps a full unchanged English sentence as a cue-level retry instead of a provider failure', () => {
    const source = 'How are you today?';
    expect(validateGoogleFreePayload(source, 'cue-1', [[source]])).toEqual({
      ok: true,
      value: { translations: [], retryCueIds: ['cue-1'] },
    });
    expect(validateDeepSeekPayload(request(source), {
      translations: [{ id: 'cue-1', text: source }],
    })).toEqual({
      ok: true,
      value: { translations: [], retryCueIds: ['cue-1'] },
    });
  });
});
