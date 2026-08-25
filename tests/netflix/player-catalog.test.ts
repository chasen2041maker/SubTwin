import { describe, expect, it, vi } from 'vitest';

import {
  readNetflixPlayerCatalog,
  type NetflixPlayerCatalogError,
} from '../../src/netflix/player-catalog';
import { extractNetflixCatalogDownloadResources } from '../../src/netflix/catalog-download';

interface PlayerFixtureOptions {
  readonly internalManifest?: unknown;
  readonly manifest?: unknown;
  readonly movieId?: unknown;
  readonly sessions?: unknown;
  readonly timedTextTracks?: unknown;
  readonly tracks?: unknown;
}

function playerFixture(options: PlayerFixtureOptions = {}) {
  const getAllPlayerSessionIds = vi.fn(() =>
    options.sessions === undefined ? ['preview-1', 'watch-8012345'] : options.sessions,
  );
  const getMovieId = vi.fn(() =>
    options.movieId === undefined ? 8_012_345 : options.movieId,
  );
  const getTextTrackList = vi.fn(() =>
    options.tracks === undefined
      ? [
          {
            trackId: 'en-main',
            bcp47: 'en-US',
            rawTrackType: 'SUBTITLES',
          },
          {
            id: 'zh-main',
            languageCode: 'zh_cn',
            trackType: 'CLOSEDCAPTIONS',
          },
        ]
      : options.tracks,
  );
  const setTextTrack = vi.fn();
  const seek = vi.fn();
  const play = vi.fn();
  const getManifest = vi.fn(() => options.manifest);
  const getTimedTextTrackList = vi.fn(() => options.timedTextTracks);
  const getInternalPlayer = vi.fn(() => ({
    playback: {
      manifest: {
        manifestResult: options.internalManifest,
      },
    },
  }));
  const player: Record<string, unknown> = {
    getMovieId,
    getTextTrackList,
    play,
    seek,
    setTextTrack,
  };
  if (options.manifest !== undefined) player.getManifest = getManifest;
  if (options.timedTextTracks !== undefined) {
    player.getTimedTextTrackList = getTimedTextTrackList;
  }
  if (options.internalManifest !== undefined) {
    player.getInternalPlayer = getInternalPlayer;
  }
  const getVideoPlayerBySessionId = vi.fn(() => player);
  const getAPI = vi.fn(() => ({
    videoPlayer: {
      getAllPlayerSessionIds,
      getVideoPlayerBySessionId,
    },
  }));
  const target = {
    netflix: {
      appContext: {
        state: {
          playerApp: { getAPI },
        },
      },
    },
  };

  return {
    getAPI,
    getAllPlayerSessionIds,
    getMovieId,
    getManifest,
    getInternalPlayer,
    getTextTrackList,
    getTimedTextTrackList,
    getVideoPlayerBySessionId,
    play,
    seek,
    setTextTrack,
    target,
  };
}

function expectErrorCode(
  result: ReturnType<typeof readNetflixPlayerCatalog>,
  code: NetflixPlayerCatalogError['code'],
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatchObject({ code, retryable: false });
    expect(JSON.stringify(result.error)).not.toMatch(/signed|secret|token/iu);
  }
}

describe('authoritative Netflix player catalog reader', () => {
  it('uses the same safe logical ID for Player trackId and manifest new_track_id', () => {
    const logicalId = 'T:2:0;1;en;0;0;0;';
    const player = readNetflixPlayerCatalog(playerFixture({
      tracks: [{
        trackId: logicalId.slice(0, -1),
        bcp47: 'en',
        rawTrackType: 'SUBTITLES',
      }],
    }).target);
    const resources = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      timedtexttracks: [{
        id: 'legacy-resource-object-id',
        new_track_id: logicalId,
        bcp47: 'en',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          'webvtt-lssdh-ios8': {
            downloadUrls: {
              primary: 'https://ipv4-c001-lax001.nflxvideo.net/timedtext/en/track.vtt',
            },
          },
        },
      }],
    });

    expect(player.ok).toBe(true);
    expect(resources.ok).toBe(true);
    if (!player.ok || !resources.ok) return;
    expect(player.value.tracks[0]?.id).toMatch(/^track_[a-f0-9]{16}$/u);
    expect(resources.value[0]?.trackId).toBe(player.value.tracks[0]?.id);
  });

  it('reads and sanitizes the complete MAIN-world player text-track list', () => {
    const fixture = playerFixture();

    expect(readNetflixPlayerCatalog(fixture.target)).toEqual({
      ok: true,
      value: {
        type: 'catalog',
        titleId: '8012345',
        authority: 'authoritative',
        tracks: [
          { id: 'en-main', language: 'en-US', kind: 'subtitle' },
          { id: 'zh-main', language: 'zh-cn', kind: 'closed-caption' },
        ],
      },
    });
    expect(fixture.getVideoPlayerBySessionId).toHaveBeenCalledTimes(1);
    expect(fixture.getVideoPlayerBySessionId).toHaveBeenCalledWith('watch-8012345');
    expect(fixture.getMovieId).toHaveBeenCalledTimes(1);
    expect(fixture.getTextTrackList).toHaveBeenCalledTimes(1);
    expect(fixture.setTextTrack).not.toHaveBeenCalled();
    expect(fixture.seek).not.toHaveBeenCalled();
    expect(fixture.play).not.toHaveBeenCalled();
  });

  it('optionally exposes raw player track metadata only to a MAIN-world callback', () => {
    const tracks = [
      {
        trackId: 'en-main',
        bcp47: 'en-US',
        rawTrackType: 'SUBTITLES',
        downloadables: {
          webvtt: { urls: ['https://cdn.nflximg.net/subtitle.vtt?token=secret'] },
        },
      },
      {
        trackId: 'zh-main',
        bcp47: 'zh-Hans',
        rawTrackType: 'SUBTITLES',
      },
    ];
    const fixture = playerFixture({ tracks });
    const onMetadata = vi.fn();

    const result = readNetflixPlayerCatalog(fixture.target, onMetadata);

    expect(result.ok).toBe(true);
    expect(onMetadata).toHaveBeenCalledOnce();
    expect(onMetadata).toHaveBeenCalledWith({
      titleId: '8012345',
      timedtexttracks: tracks,
    });
    expect(JSON.stringify(result)).not.toContain('token=secret');
    expect(JSON.stringify(result)).not.toContain('downloadables');
  });

  it('prefers a read-only player manifest for MAIN-world metadata extraction', () => {
    const manifest = {
      timedtexttracks: [{
        new_track_id: 'en-main',
        bcp47: 'en-US',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          'webvtt-lssdh-ios8': {
            downloadUrls: {
              primary: 'https://cdn.nflximg.net/subtitle.vtt?token=secret',
            },
          },
        },
      }],
    };
    const fixture = playerFixture({ manifest });
    const onMetadata = vi.fn();

    const result = readNetflixPlayerCatalog(fixture.target, onMetadata);

    expect(result.ok).toBe(true);
    expect(fixture.getManifest).toHaveBeenCalledOnce();
    expect(onMetadata).toHaveBeenCalledWith({
      titleId: '8012345',
      metadata: manifest,
    });
    const extracted = extractNetflixCatalogDownloadResources(
      onMetadata.mock.calls[0]?.[0],
    );
    expect(extracted.ok && extracted.value).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('token=secret');
  });

  it('reads the 2026 Cadmium internal manifest result for download metadata', () => {
    const internalManifest = {
      movieId: 8_012_345,
      timedtexttracks: [{
        new_track_id: 'en-main',
        bcp47: 'en-US',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          'webvtt-lssdh-ios8': {
            downloadUrls: {
              primary: 'https://cdn.nflximg.net/subtitle.vtt?token=secret',
            },
          },
        },
      }],
    };
    const fixture = playerFixture({ internalManifest });
    const onMetadata = vi.fn();

    const result = readNetflixPlayerCatalog(fixture.target, onMetadata);

    expect(result.ok).toBe(true);
    expect(fixture.getInternalPlayer).toHaveBeenCalledOnce();
    expect(onMetadata).toHaveBeenCalledWith({
      titleId: '8012345',
      metadata: internalManifest,
    });
    const extracted = extractNetflixCatalogDownloadResources(
      onMetadata.mock.calls[0]?.[0],
    );
    expect(extracted.ok && extracted.value).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('token=secret');
  });

  it('treats the 2026 Cadmium timed-text list as a shallow advisory fallback', () => {
    const timedTextTracks = [{
      new_track_id: 'en-main',
      bcp47: 'en-US',
      rawTrackType: 'SUBTITLES',
    }];
    const fixture = playerFixture({ timedTextTracks });
    const onMetadata = vi.fn();

    const result = readNetflixPlayerCatalog(fixture.target, onMetadata);

    expect(result.ok).toBe(true);
    expect(fixture.getTimedTextTrackList).toHaveBeenCalledOnce();
    expect(onMetadata).toHaveBeenCalledWith({
      titleId: '8012345',
      timedtexttracks: timedTextTracks,
    });
    const extracted = extractNetflixCatalogDownloadResources(
      onMetadata.mock.calls[0]?.[0],
    );
    expect(extracted.ok && extracted.value).toEqual([]);
  });

  it('keeps metadata callback failures advisory to the authoritative catalog', () => {
    const fixture = playerFixture();

    expect(() => readNetflixPlayerCatalog(fixture.target, () => {
      throw new Error('observer failed');
    })).not.toThrow();
  });

  it('uses the first valid session when no watch session exists', () => {
    const fixture = playerFixture({
      sessions: ['', null, 'preview-2', 'playback-3'],
      tracks: [],
    });

    expect(readNetflixPlayerCatalog(fixture.target)).toEqual({
      ok: true,
      value: {
        type: 'catalog',
        titleId: '8012345',
        authority: 'authoritative',
        tracks: [],
      },
    });
    expect(fixture.getVideoPlayerBySessionId).toHaveBeenCalledWith('preview-2');
  });

  it('supports common language, ID, enum, and boolean fields without copying extras', () => {
    const fixture = playerFixture({
      movieId: 'unsafe/movie/id?account=secret',
      tracks: [
        {
          downloadableId: 91,
          language: 'fr-FR',
          kind: 'subtitle',
          downloadables: { webvtt: { url: 'https://signed-secret.invalid' } },
        },
        {
          new_track_id: 'de-cc',
          bcp47Tag: 'de-DE',
          isClosedCaption: true,
          token: 'must-not-leak',
        },
        {
          bcp47: 'es-419',
          rawTrackType: 'SUBTITLE',
          id: 'unsafe/id?secret',
        },
      ],
    });

    const result = readNetflixPlayerCatalog(fixture.target);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.titleId).toMatch(/^title-[a-f0-9]{16}$/u);
    expect(result.value.tracks).toEqual([
      { id: '91', language: 'fr-FR', kind: 'subtitle' },
      { id: 'de-cc', language: 'de-DE', kind: 'closed-caption' },
      {
        id: expect.stringMatching(/^track-[a-f0-9]{16}$/u),
        language: 'es-419',
        kind: 'subtitle',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('signed-secret');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('unsafe/id');
  });

  it('drops none and forced-narrative entries before validating subtitle fields', () => {
    const fixture = playerFixture({
      tracks: [
        { isNoneTrack: true, displayName: 'Off', token: 'secret-none' },
        { bcp47: 'en-US', rawTrackType: 'FORCED_NARRATIVE' },
        {
          bcp47: 'fr-FR',
          isForcedNarrative: true,
          rawTrackType: 'SUBTITLES',
        },
        { bcp47: 'en-GB', rawTrackType: 'SUBTITLES', trackId: 'en-real' },
      ],
    });

    expect(readNetflixPlayerCatalog(fixture.target)).toEqual({
      ok: true,
      value: {
        type: 'catalog',
        titleId: '8012345',
        authority: 'authoritative',
        tracks: [{ id: 'en-real', language: 'en-GB', kind: 'subtitle' }],
      },
    });
  });

  it('deduplicates an exact repeated safe ID but rejects conflicting metadata', () => {
    const duplicate = playerFixture({
      tracks: [
        { trackId: 'en', bcp47: 'en-US', rawTrackType: 'SUBTITLES' },
        { trackId: 'en', bcp47: 'en-US', rawTrackType: 'SUBTITLES' },
      ],
    });
    const conflict = playerFixture({
      tracks: [
        { trackId: 'shared', bcp47: 'en-US', rawTrackType: 'SUBTITLES' },
        { trackId: 'shared', bcp47: 'zh-CN', rawTrackType: 'SUBTITLES' },
      ],
    });

    const duplicateResult = readNetflixPlayerCatalog(duplicate.target);
    expect(duplicateResult.ok && duplicateResult.value.tracks).toEqual([
      { id: 'en', language: 'en-US', kind: 'subtitle' },
    ]);
    expectErrorCode(
      readNetflixPlayerCatalog(conflict.target),
      'netflix_player_catalog_conflict',
    );
  });

  it.each([
    {
      name: 'missing Netflix API',
      target: {},
      code: 'netflix_player_api_unavailable' as const,
    },
    {
      name: 'non-array sessions',
      target: playerFixture({ sessions: { 0: 'watch-1' } }).target,
      code: 'netflix_player_session_invalid' as const,
    },
    {
      name: 'no legal session',
      target: playerFixture({ sessions: ['', null, 42] }).target,
      code: 'netflix_player_session_unavailable' as const,
    },
    {
      name: 'non-array catalog',
      target: playerFixture({ tracks: { 0: {} } }).target,
      code: 'netflix_player_catalog_invalid' as const,
    },
    {
      name: 'missing BCP47 language',
      target: playerFixture({
        tracks: [{ displayName: 'English', rawTrackType: 'SUBTITLES' }],
      }).target,
      code: 'netflix_player_catalog_invalid' as const,
    },
    {
      name: 'unrecognized kind',
      target: playerFixture({
        tracks: [{ bcp47: 'en-US', rawTrackType: 'AUDIO', trackId: 'bad' }],
      }).target,
      code: 'netflix_player_catalog_invalid' as const,
    },
    {
      name: 'conflicting language fields',
      target: playerFixture({
        tracks: [
          {
            bcp47: 'en-US',
            languageCode: 'zh-CN',
            rawTrackType: 'SUBTITLES',
          },
        ],
      }).target,
      code: 'netflix_player_catalog_invalid' as const,
    },
  ])('fails closed for $name', ({ target, code }) => {
    expectErrorCode(readNetflixPlayerCatalog(target), code);
  });

  it('rejects a track list above the hard limit without inspecting entries', () => {
    let reads = 0;
    const first = Object.defineProperty({}, 'bcp47', {
      get() {
        reads += 1;
        return 'en-US';
      },
    });
    const fixture = playerFixture({
      tracks: [first, ...Array.from({ length: 256 }, () => ({}))],
    });

    expectErrorCode(
      readNetflixPlayerCatalog(fixture.target),
      'netflix_player_catalog_too_large',
    );
    expect(reads).toBe(0);
  });

  it('converts page getter and method exceptions into non-sensitive typed errors', () => {
    const target = {
      netflix: {
        appContext: {
          state: {
            playerApp: {
              getAPI: vi.fn(() => {
                throw new Error('signed-token=do-not-leak');
              }),
            },
          },
        },
      },
    };

    expectErrorCode(
      readNetflixPlayerCatalog(target),
      'netflix_player_api_failed',
    );

    const fixture = playerFixture();
    fixture.getTextTrackList.mockImplementation(() => {
      throw new Error('secret subtitle URL');
    });
    expectErrorCode(
      readNetflixPlayerCatalog(fixture.target),
      'netflix_player_catalog_failed',
    );
  });
});
