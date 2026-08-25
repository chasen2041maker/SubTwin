import { describe, expect, it, vi } from 'vitest';

import {
  prepareNetflixPlayerTrackCapture,
} from '../../src/netflix/player-catalog';

function captureFixture(options: {
  readonly current?: unknown;
  readonly movieId?: unknown;
  readonly includeSetter?: boolean;
} = {}) {
  const english = {
    trackId: 'en-main',
    bcp47: 'en',
    rawTrackType: 'SUBTITLES',
  };
  const chinese = {
    trackId: 'zh-main',
    bcp47: 'zh-Hans',
    rawTrackType: 'SUBTITLES',
  };
  const tracks = [english, chinese];
  const getTimedTextTrack = vi.fn(() => options.current ?? english);
  const setTimedTextTrack = vi.fn();
  const player: Record<string, unknown> = {
    getMovieId: vi.fn(() => options.movieId ?? 'title-1'),
    getTextTrackList: vi.fn(() => tracks),
    getTimedTextTrack,
  };
  if (options.includeSetter !== false) {
    player.setTimedTextTrack = setTimedTextTrack;
  }
  const target = {
    netflix: {
      appContext: {
        state: {
          playerApp: {
            getAPI: () => ({
              videoPlayer: {
                getAllPlayerSessionIds: () => ['watch-title-1'],
                getVideoPlayerBySessionId: () => player,
              },
            }),
          },
        },
      },
    },
  };

  return { chinese, english, getTimedTextTrack, setTimedTextTrack, target };
}

const catalog = {
  type: 'catalog' as const,
  titleId: 'title-1',
  authority: 'authoritative' as const,
  tracks: [
    { id: 'en-main', language: 'en', kind: 'subtitle' as const },
    { id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' as const },
  ],
};

describe('controlled Netflix timed-text track capture', () => {
  it('switches only to a catalog-validated raw track and restores the exact original track once', () => {
    const fixture = captureFixture();
    const prepared = prepareNetflixPlayerTrackCapture(fixture.target, catalog);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.originalTrackId).toBe('en-main');
    expect(prepared.value.switchTo('missing')).toBe(false);
    expect(fixture.setTimedTextTrack).not.toHaveBeenCalled();

    expect(prepared.value.switchTo('zh-main')).toBe(true);
    expect(fixture.setTimedTextTrack).toHaveBeenCalledWith(fixture.chinese);

    prepared.value.restore();
    prepared.value.restore();
    expect(fixture.setTimedTextTrack).toHaveBeenNthCalledWith(2, fixture.english);
    expect(fixture.setTimedTextTrack).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the live title differs or reversible track control is unavailable', () => {
    const wrongTitle = captureFixture({ movieId: 'title-2' });
    const unavailable = captureFixture({ includeSetter: false });

    expect(prepareNetflixPlayerTrackCapture(wrongTitle.target, catalog).ok).toBe(false);
    expect(wrongTitle.setTimedTextTrack).not.toHaveBeenCalled();
    expect(prepareNetflixPlayerTrackCapture(unavailable.target, catalog).ok).toBe(false);
    expect(unavailable.setTimedTextTrack).not.toHaveBeenCalled();
  });

  it('contains page exceptions and never leaves restore throwing into Netflix', () => {
    const fixture = captureFixture();
    fixture.setTimedTextTrack.mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('Netflix changed the player');
      });
    const prepared = prepareNetflixPlayerTrackCapture(fixture.target, catalog);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.switchTo('zh-main')).toBe(true);
    expect(() => prepared.value.restore()).not.toThrow();
  });
});
