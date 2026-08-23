import type { SubtitleCue, SubtitleTrack } from './types';

export const DEFAULT_ALIGNMENT_TOLERANCE_MS = 250;

export type OfficialAlignmentMatch = 'gap' | 'nearby' | 'overlap';

export interface OfficialCueAlignment {
  readonly source: SubtitleCue;
  readonly targets: readonly SubtitleCue[];
  readonly targetText: string | null;
  readonly match: OfficialAlignmentMatch;
}

export interface OfficialAlignmentOptions {
  readonly toleranceMs?: number;
}

export function alignOfficialTracks(
  sourceTrack: SubtitleTrack,
  targetTrack: SubtitleTrack,
  options: OfficialAlignmentOptions = {},
): readonly OfficialCueAlignment[] {
  const requestedTolerance = options.toleranceMs ??
    DEFAULT_ALIGNMENT_TOLERANCE_MS;
  const toleranceMs = Number.isFinite(requestedTolerance) && requestedTolerance >= 0
    ? requestedTolerance
    : DEFAULT_ALIGNMENT_TOLERANCE_MS;
  const targets = [...targetTrack.cues].sort(compareCues);

  const alignments = sourceTrack.cues.map((source) => {
    const overlapping = targets.filter((target) => overlapMs(source, target) > 0);

    if (overlapping.length > 0) {
      return createAlignment(source, overlapping, 'overlap');
    }

    const nearby = targets
      .map((target) => ({ target, distanceMs: intervalDistanceMs(source, target) }))
      .filter(({ distanceMs }) => distanceMs <= toleranceMs)
      .sort(
        (left, right) =>
          left.distanceMs - right.distanceMs ||
          compareCues(left.target, right.target),
      );
    const nearest = nearby[0]?.target;

    return nearest === undefined
      ? createAlignment(source, [], 'gap')
      : createAlignment(source, [nearest], 'nearby');
  });

  return Object.freeze(alignments);
}

function createAlignment(
  source: SubtitleCue,
  targets: readonly SubtitleCue[],
  match: OfficialAlignmentMatch,
): OfficialCueAlignment {
  const frozenTargets = Object.freeze([...targets].sort(compareCues));
  return Object.freeze({
    source,
    targets: frozenTargets,
    targetText:
      frozenTargets.length === 0
        ? null
        : frozenTargets.map(({ text }) => text).join('\n'),
    match,
  });
}

function overlapMs(left: SubtitleCue, right: SubtitleCue): number {
  return Math.max(
    0,
    Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs),
  );
}

function intervalDistanceMs(left: SubtitleCue, right: SubtitleCue): number {
  if (left.endMs <= right.startMs) return right.startMs - left.endMs;
  if (right.endMs <= left.startMs) return left.startMs - right.endMs;
  return 0;
}

function compareCues(left: SubtitleCue, right: SubtitleCue): number {
  return (
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
