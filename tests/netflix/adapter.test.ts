import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  applyNetflixAdapterEvent,
  canonicalizeTimedTextResource,
  createNetflixAdapterState,
  normalizeNetflixLanguageTag,
} from '../../src/netflix/adapter';
import {
  NETFLIX_ADAPTER_VERSION,
  type NetflixAdapterEvent,
  type NetflixAdapterState,
} from '../../src/netflix/types';

const versioned = <T extends Omit<NetflixAdapterEvent, 'adapterVersion'>>(
  event: T,
): NetflixAdapterEvent => ({
  ...event,
  adapterVersion: NETFLIX_ADAPTER_VERSION,
} as unknown as NetflixAdapterEvent);

function currentEvent<T extends Omit<NetflixAdapterEvent, 'adapterVersion' | 'generation' | 'sessionId'>>(
  state: NetflixAdapterState,
  event: T,
): NetflixAdapterEvent {
  return versioned({
    ...event,
    generation: state.session.generation,
    sessionId: state.session.sessionId,
  } as Omit<NetflixAdapterEvent, 'adapterVersion'>);
}

function apply(
  state: NetflixAdapterState,
  event: NetflixAdapterEvent,
): NetflixAdapterState {
  const result = applyNetflixAdapterEvent(state, event);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('Netflix language normalization', () => {
  it('recognizes English and only explicit Simplified Chinese tags', () => {
    expect(normalizeNetflixLanguageTag('EN_us')).toEqual({
      category: 'english',
      sourceTag: 'en-US',
      tag: 'en',
    });
    expect(normalizeNetflixLanguageTag('zh_cn')).toEqual({
      category: 'simplified-chinese',
      sourceTag: 'zh-CN',
      tag: 'zh-Hans',
    });
    expect(normalizeNetflixLanguageTag('zh-Hans-SG')).toEqual({
      category: 'simplified-chinese',
      sourceTag: 'zh-Hans-SG',
      tag: 'zh-Hans',
    });
    expect(normalizeNetflixLanguageTag('zh')).toMatchObject({ category: 'other' });
    expect(normalizeNetflixLanguageTag('zh-Hant')).toMatchObject({ category: 'other' });
    expect(normalizeNetflixLanguageTag('zh-TW')).toMatchObject({ category: 'other' });
    expect(normalizeNetflixLanguageTag('Chinese (Simplified)')).toBeNull();
  });
});

describe('Netflix catalog policy', () => {
  it('allows external translation only from authoritative English-without-Simplified-Chinese evidence', () => {
    let state = createNetflixAdapterState({
      contentId: 'episode-1',
      mountId: 'player-a',
    });

    state = apply(state, currentEvent(state, {
      type: 'catalog-observed',
      authority: 'provisional',
      tracks: [{ trackId: 'en-main', languageTag: 'en-US' }],
    }));
    expect(state.externalTranslationAllowed).toBe(false);

    state = apply(state, currentEvent(state, {
      type: 'catalog-observed',
      authority: 'authoritative',
      tracks: [{ trackId: 'en-main', languageTag: 'en-US' }],
    }));
    expect(state.externalTranslationAllowed).toBe(true);

    state = apply(state, currentEvent(state, {
      type: 'track-observed',
      track: { trackId: 'en-main', languageTag: 'en-US' },
    }));
    expect(state.catalog.authority).toBe('authoritative');
    expect(state.externalTranslationAllowed).toBe(true);

    state = apply(state, currentEvent(state, {
      type: 'catalog-observed',
      authority: 'provisional',
      tracks: [{ trackId: 'en-main', languageTag: 'en' }],
    }));
    expect(state.catalog.authority).toBe('authoritative');
    expect(state.externalTranslationAllowed).toBe(true);

    state = apply(state, currentEvent(state, {
      type: 'track-observed',
      track: { trackId: 'zh-main', languageTag: 'zh-CN' },
    }));
    expect(state.catalog.authority).toBe('provisional');
    expect(state.externalTranslationAllowed).toBe(false);
    expect(state.catalog.tracks.map(({ trackId }) => trackId)).toContain('zh-main');
  });

  it('unlocks an authoritative English catalog even when Simplified Chinese is available', () => {
    const initial = createNetflixAdapterState({
      contentId: 'episode-1',
      mountId: 'player-a',
    });
    const state = apply(initial, currentEvent(initial, {
      type: 'catalog-observed',
      authority: 'authoritative',
      tracks: [
        { trackId: 'en', languageTag: 'en' },
        { trackId: 'zh', languageTag: 'zh-SG' },
      ],
    }));

    expect(state.externalTranslationAllowed).toBe(true);
  });

  it('never unlocks an authoritative catalog that lacks English', () => {
    const initial = createNetflixAdapterState({
      contentId: 'episode-1',
      mountId: 'player-a',
    });
    const state = apply(initial, currentEvent(initial, {
      type: 'catalog-observed',
      authority: 'authoritative',
      tracks: [{ trackId: 'zh', languageTag: 'zh-Hans' }],
    }));

    expect(state.externalTranslationAllowed).toBe(false);
  });
});

describe('Netflix track lifecycle and scheduling scope', () => {
  it('limits an active provisional track to urgent work and promotes only after confirmation', () => {
    let state = createNetflixAdapterState({
      contentId: 'episode-1',
      mountId: 'player-a',
    });
    state = apply(state, currentEvent(state, {
      type: 'track-observed',
      track: { trackId: 'en-main', languageTag: 'en' },
    }));
    state = apply(state, currentEvent(state, {
      type: 'track-activity-changed',
      trackId: 'en-main',
      active: true,
    }));

    expect(state.tracks).toMatchObject([
      { trackId: 'en-main', lifecycle: 'provisional', active: true },
    ]);
    expect(state.schedulingScope).toBe('urgent-window');

    state = apply(state, currentEvent(state, {
      type: 'catalog-observed',
      authority: 'authoritative',
      tracks: [{ trackId: 'en-main', languageTag: 'en-US' }],
    }));
    expect(state.tracks[0]).toMatchObject({ lifecycle: 'confirmed', active: true });
    expect(state.schedulingScope).toBe('bulk');

    state = apply(state, currentEvent(state, {
      type: 'track-observed',
      track: { trackId: 'zh-main', languageTag: 'zh-CN' },
    }));
    expect(state.schedulingScope).toBe('urgent-window');

    state = apply(state, currentEvent(state, {
      type: 'track-activity-changed',
      trackId: 'en-main',
      active: false,
    }));
    expect(state.schedulingScope).toBe('none');

    state = apply(state, currentEvent(state, {
      type: 'track-disposed',
      trackId: 'en-main',
    }));
    expect(state.tracks[0]).toMatchObject({ lifecycle: 'disposed', active: false });
    expect(state.schedulingScope).toBe('none');

    state = apply(state, currentEvent(state, {
      type: 'track-observed',
      track: { trackId: 'en-main', languageTag: 'en' },
    }));
    expect(state.tracks[0]).toMatchObject({ lifecycle: 'disposed', active: false });
    expect(state.schedulingScope).toBe('none');
  });
});

describe('Netflix generation safety', () => {
  it('gives separate adapter instances unique identities for the same seed', () => {
    let nonce = 0;
    const nonceFactory = (): string => `nonce-${nonce += 1}`;
    const seed = { contentId: 'episode-1', mountId: 'player-a' } as const;

    const first = createNetflixAdapterState(seed, { nonceFactory });
    const second = createNetflixAdapterState(seed, { nonceFactory });

    expect(first.session.sessionId).not.toBe(second.session.sessionId);
  });

  it('never exposes unsafe raw session identity input', () => {
    const state = createNetflixAdapterState({
      contentId: 'https://www.netflix.com/watch/1?token=session-secret',
      mountId: 'player-a',
    });

    expect(state.session.contentId).toMatch(/^content_[0-9a-f]{16}$/u);
    expect(JSON.stringify(state)).not.toContain('session-secret');
    expect(JSON.stringify(state)).not.toContain('https://');
  });

  it('creates a new identity on episode/remount transition and disposes old tracks', () => {
    let state = createNetflixAdapterState({
      contentId: 'episode-1',
      mountId: 'player-a',
    });
    state = apply(state, currentEvent(state, {
      type: 'track-observed',
      track: { trackId: 'en-main', languageTag: 'en' },
    }));
    const oldSession = state.session;

    state = apply(state, currentEvent(state, {
      type: 'session-transition',
      reason: 'episode-change',
      nextContentId: 'episode-2',
      nextMountId: 'player-b',
    }));

    expect(state.session.generation).toBe(oldSession.generation + 1);
    expect(state.session.sessionId).not.toBe(oldSession.sessionId);
    expect(state.catalog).toMatchObject({ authority: 'provisional', tracks: [] });
    expect(state.tracks).toMatchObject([
      { trackId: 'en-main', lifecycle: 'disposed', active: false },
    ]);
    expect(state.externalTranslationAllowed).toBe(false);
    expect(state.schedulingScope).toBe('none');

    const staleGeneration = applyNetflixAdapterEvent(state, versioned({
      type: 'track-observed',
      sessionId: state.session.sessionId,
      generation: oldSession.generation,
      track: { trackId: 'late-en', languageTag: 'en' },
    }));
    expect(staleGeneration).toMatchObject({
      ok: false,
      error: { code: 'netflix_stale_generation', retryable: false },
    });

    const staleSession = applyNetflixAdapterEvent(state, versioned({
      type: 'track-observed',
      sessionId: oldSession.sessionId,
      generation: state.session.generation,
      track: { trackId: 'late-en', languageTag: 'en' },
    }));
    expect(staleSession).toMatchObject({
      ok: false,
      error: { code: 'netflix_stale_session', retryable: false },
    });
  });

  it.each(['episode-change', 'player-remount'] as const)(
    'strips old resources during %s',
    (reason) => {
    let state = createNetflixAdapterState({
      contentId: 'episode-1',
      mountId: 'player-a',
    });
    const resource = canonicalizeTimedTextResource(
      'https://cdn.nflxvideo.net/subtitles/en.vtt?sig=old-secret',
      'en-main',
      'en',
    );
    expect(resource.ok).toBe(true);
    if (!resource.ok) return;
    state = apply(state, currentEvent(state, {
      type: 'track-observed',
      track: { trackId: 'en-main', languageTag: 'en', resource: resource.value },
    }));

    state = apply(state, currentEvent(state, {
      type: 'session-transition',
      reason,
      nextContentId: 'episode-1',
      nextMountId: 'player-b',
    }));
    expect(state.tracks[0]).not.toHaveProperty('resource');

    state = apply(state, currentEvent(state, {
      type: 'catalog-observed',
      authority: 'authoritative',
      tracks: [{ trackId: 'en-main', languageTag: 'en' }],
    }));
    expect(state.tracks[0]).not.toHaveProperty('resource');
    },
  );

  it('returns non-sensitive typed errors for unsupported input and version mismatch', () => {
    const state = createNetflixAdapterState({
      contentId: 'episode-1',
      mountId: 'player-a',
    });
    const unsupported = applyNetflixAdapterEvent(state, {
      token: 'do-not-echo',
      rawSignedUrl: 'https://example.test/subtitle?token=secret',
    });
    const mismatched = applyNetflixAdapterEvent(state, {
      adapterVersion: 'netflix-adapter-v0',
      type: 'track-observed',
    });

    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: 'netflix_unsupported_input', retryable: false },
    });
    expect(mismatched).toMatchObject({
      ok: false,
      error: { code: 'netflix_adapter_version_mismatch', retryable: false },
    });
    expect(JSON.stringify({ unsupported, mismatched })).not.toContain('do-not-echo');
    expect(JSON.stringify({ unsupported, mismatched })).not.toContain('token=secret');
  });

  it('strictly rejects extra sensitive fields and inconsistent resource language', () => {
    const state = createNetflixAdapterState({
      contentId: 'episode-1',
      mountId: 'player-a',
    });
    const canonical = canonicalizeTimedTextResource(
      'https://cdn.nflxvideo.net/subtitles/en.vtt?sig=secret',
      'en-main',
      'en-US',
    );
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;

    const sensitive = applyNetflixAdapterEvent(state, {
      ...currentEvent(state, {
        type: 'track-observed',
        track: {
          trackId: 'en-main',
          languageTag: 'en-US',
          resource: {
            ...canonical.value,
            authorization: 'Bearer do-not-echo',
          },
        },
      }),
    });
    const inconsistent = applyNetflixAdapterEvent(state, currentEvent(state, {
      type: 'track-observed',
      track: {
        trackId: 'en-main',
        languageTag: 'en-US',
        resource: {
          ...canonical.value,
          language: { category: 'other', sourceTag: 'fr', tag: 'fr' },
        },
      },
    }));

    expect(sensitive).toMatchObject({
      ok: false,
      error: { code: 'netflix_unsupported_input' },
    });
    expect(inconsistent).toMatchObject({
      ok: false,
      error: { code: 'netflix_unsupported_input' },
    });
    expect(JSON.stringify({ sensitive, inconsistent })).not.toContain('do-not-echo');
  });
});

describe('timed-text resource canonicalization', () => {
  it('deduplicates signed range fragments without exposing raw URL data', () => {
    const first = canonicalizeTimedTextResource(
      'https://ipv4-c012.example.nflxvideo.net/range/0-999/subtitles/en.vtt?token=first-secret&sig=aaa',
      'en-main',
      'en-US',
    );
    const second = canonicalizeTimedTextResource(
      'https://ipv4-c012.example.nflxvideo.net/range/1000-1999/subtitles/en.vtt?token=second-secret&sig=bbb',
      'en-main',
      'en-US',
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expectTypeOf(first.value.resourceId).toBeString();
    expect(first.value).toEqual({
      resourceId: second.value.resourceId,
      trackId: 'en-main',
      language: { category: 'english', sourceTag: 'en-US', tag: 'en' },
      hostCategory: 'netflix-timed-text',
      pathCategory: 'webvtt',
    });
    const serialized = JSON.stringify(first.value);
    expect(serialized).not.toContain('first-secret');
    expect(serialized).not.toContain('nflxvideo.net');
    expect(serialized).not.toContain('?');
    expect(serialized).not.toContain('/range/');
  });

  it('does not merge an explicitly different track or language', () => {
    const raw = 'https://cdn.nflxvideo.net/range/0-9/timed-text/file.ttml?token=secret';
    const english = canonicalizeTimedTextResource(raw, 'track-a', 'en');
    const differentTrack = canonicalizeTimedTextResource(raw, 'track-b', 'en');
    const differentLanguage = canonicalizeTimedTextResource(raw, 'track-a', 'zh-Hans');

    expect(english.ok && differentTrack.ok && differentLanguage.ok).toBe(true);
    if (!english.ok || !differentTrack.ok || !differentLanguage.ok) return;
    expect(new Set([
      english.value.resourceId,
      differentTrack.value.resourceId,
      differentLanguage.value.resourceId,
    ]).size).toBe(3);
  });

  it('does not merge resources from distinct Netflix-owned domain families', () => {
    const video = canonicalizeTimedTextResource(
      'https://cdn.netflix.com/subtitles/en.vtt', 'track-a', 'en',
    );
    const image = canonicalizeTimedTextResource(
      'https://cdn.nflximg.net/subtitles/en.vtt', 'track-a', 'en',
    );
    expect(video.ok && image.ok).toBe(true);
    if (!video.ok || !image.ok) return;
    expect(video.value.resourceId).not.toBe(image.value.resourceId);
  });

  it.each([
    'http://cdn.nflxvideo.net/subtitles/en.vtt?token=secret-http',
    'https://nflxvideo.net.evil.example/subtitles/en.vtt?token=secret-host',
    'https://www.netflix.com/browse?token=secret-not-timed-text',
    'not-a-url?token=secret-invalid',
  ])('rejects unsupported URL input without echoing it: %s', (raw) => {
    const result = canonicalizeTimedTextResource(raw, 'en-main', 'en');
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'netflix_invalid_timed_text_resource', retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(JSON.stringify(result)).not.toContain(raw);
  });
});
