import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ALIGNMENT_TOLERANCE_MS,
  alignOfficialTracks,
} from '../../src/subtitles/align';
import type { SubtitleCue, SubtitleTrack } from '../../src/subtitles/types';

const cue = (
  id: string,
  startMs: number,
  endMs: number,
  text: string,
): SubtitleCue => ({ id, startMs, endMs, text });

const track = (
  id: string,
  tag: string,
  cues: readonly SubtitleCue[],
): SubtitleTrack => ({
  id,
  format: 'webvtt',
  language: { tag },
  cues,
});

describe('official subtitle alignment', () => {
  it('aligns one source cue to one target cue by interval overlap', () => {
    const sourceCue = cue('en-1', 1_000, 2_000, 'North star.');
    const targetCue = cue('zh-1', 1_100, 1_900, '北星。');

    const result = alignOfficialTracks(
      track('en', 'en', [sourceCue]),
      track('zh', 'zh-Hans', [targetCue]),
    );

    expect(result).toEqual([
      {
        source: sourceCue,
        targets: [targetCue],
        targetText: '北星。',
        match: 'overlap',
      },
    ]);
  });

  it('merges ordered target segments for a one-to-many overlap', () => {
    const sourceCue = cue('en-wide', 1_000, 4_000, 'Red kite rises.');
    const late = cue('zh-late', 2_100, 3_900, '升起。');
    const early = cue('zh-early', 1_050, 2_000, '红风筝');

    const [alignment] = alignOfficialTracks(
      track('en', 'en', [sourceCue]),
      track('zh', 'zh-Hans', [late, early]),
    );

    expect(alignment).toMatchObject({
      targets: [early, late],
      targetText: '红风筝\n升起。',
      match: 'overlap',
    });
  });

  it('maps multiple source segments to the same overlapping target interval', () => {
    const first = cue('en-a', 1_000, 1_900, 'Small river.');
    const second = cue('en-b', 2_000, 3_000, 'Green hill.');
    const targetCue = cue('zh-wide', 900, 3_100, '小河与青山。');

    const result = alignOfficialTracks(
      track('en', 'en', [first, second]),
      track('zh', 'zh-Hans', [targetCue]),
    );

    expect(result.map(({ targets }) => targets.map(({ id }) => id))).toEqual([
      ['zh-wide'],
      ['zh-wide'],
    ]);
  });

  it('uses the nearest near-touching cue inside tolerance', () => {
    const sourceCue = cue('en-1', 1_000, 1_500, 'Open gate.');
    const farther = cue('zh-farther', 1_650, 1_900, '远。');
    const nearer = cue('zh-nearer', 1_575, 1_800, '近。');

    const [alignment] = alignOfficialTracks(
      track('en', 'en', [sourceCue]),
      track('zh', 'zh-Hans', [farther, nearer]),
      { toleranceMs: DEFAULT_ALIGNMENT_TOLERANCE_MS },
    );

    expect(alignment).toMatchObject({
      targets: [nearer],
      targetText: '近。',
      match: 'nearby',
    });
  });

  it('breaks equal-distance ties by start, end, then stable cue ID', () => {
    const sourceCue = cue('en-1', 1_000, 1_100, 'Still pond.');
    const right = cue('zh-right', 1_150, 1_250, '右。');
    const leftZ = cue('zh-z', 850, 950, '左乙。');
    const leftA = cue('zh-a', 850, 950, '左甲。');

    const [alignment] = alignOfficialTracks(
      track('en', 'en', [sourceCue]),
      track('zh', 'zh-Hans', [right, leftZ, leftA]),
      { toleranceMs: 50 },
    );

    expect(alignment).toMatchObject({
      targets: [leftA],
      match: 'nearby',
    });
  });

  it('returns an explicit immutable gap when no target is safely close', () => {
    const sourceCue = cue('en-gap', 5_000, 6_000, 'Empty road.');
    const distant = cue('zh-distant', 7_000, 8_000, '远路。');

    const result = alignOfficialTracks(
      track('en', 'en', [sourceCue]),
      track('zh', 'zh-Hans', [distant]),
      { toleranceMs: 100 },
    );

    expect(result).toEqual([
      {
        source: sourceCue,
        targets: [],
        targetText: null,
        match: 'gap',
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result[0]?.targets)).toBe(true);
  });
});
