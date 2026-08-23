import { describe, expect, it } from 'vitest';

import { normalizeSubtitleTrack } from '../../src/subtitles/normalize';

const normalize = (
  cues: readonly {
    readonly startMs: number;
    readonly endMs: number;
    readonly text: string;
    readonly sourceId?: string;
  }[],
) =>
  normalizeSubtitleTrack({
    id: 'official-en',
    format: 'webvtt',
    language: { tag: 'en' },
    cues,
  });

describe('subtitle normalization identity', () => {
  it('keeps a cue ID stable when an unrelated earlier cue is inserted', () => {
    const target = {
      startMs: 2_000,
      endMs: 3_000,
      text: '  Blue   moon.  ',
      sourceId: 'line-b',
    } as const;
    const alone = normalize([target]);
    const withEarlierCue = normalize([
      { startMs: 500, endMs: 1_000, text: 'First light.' },
      target,
    ]);

    expect(alone.ok).toBe(true);
    expect(withEarlierCue.ok).toBe(true);
    if (!alone.ok || !withEarlierCue.ok) return;

    expect(withEarlierCue.value.cues[1]?.id).toBe(alone.value.cues[0]?.id);
  });

  it('changes the cue ID when normalized text changes at the same time', () => {
    const first = normalize([
      { startMs: 1_000, endMs: 2_000, text: 'Red leaf.' },
    ]);
    const second = normalize([
      { startMs: 1_000, endMs: 2_000, text: 'Green leaf.' },
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.cues[0]?.id).not.toBe(second.value.cues[0]?.id);
  });

  it('keeps duplicate identical cues unique and deterministic', () => {
    const duplicate = { startMs: 1_000, endMs: 2_000, text: 'Same cue.' };
    const first = normalize([duplicate, duplicate]);
    const second = normalize([duplicate, duplicate]);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) return;

    expect(new Set(first.value.cues.map(({ id }) => id)).size).toBe(2);
  });
});
