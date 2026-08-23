import { err, ok, type AppError, type Result } from '../shared/result';
import type {
  SubtitleCue,
  SubtitleFormat,
  SubtitleLanguage,
  SubtitleTrack,
} from './types';

export interface SubtitleCueDraft {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly sourceId?: string;
  readonly settings?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SubtitleTrackDraft {
  readonly id: string;
  readonly format: SubtitleFormat;
  readonly language: SubtitleLanguage;
  readonly cues: readonly SubtitleCueDraft[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export type SubtitleNormalizationError = AppError<'invalid_subtitle_track'>;

export function normalizeCueText(input: string): string {
  const lines = input
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim());

  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();

  return lines.join('\n');
}

export function normalizeSubtitleTrack(
  draft: SubtitleTrackDraft,
): Result<SubtitleTrack, SubtitleNormalizationError> {
  const trackId = draft.id.trim();
  const languageTag = draft.language.tag.trim();

  if (trackId.length === 0 || languageTag.length === 0) {
    return invalidTrack('Track and language identifiers must not be empty.');
  }

  const cues: SubtitleCue[] = [];
  const cueIdOccurrences = new Map<string, number>();

  for (const cue of draft.cues) {
    if (
      !Number.isFinite(cue.startMs) ||
      !Number.isFinite(cue.endMs) ||
      cue.startMs < 0 ||
      cue.endMs <= cue.startMs
    ) {
      return invalidTrack('Cue timestamps must form a positive finite interval.');
    }

    const startMs = Math.round(cue.startMs);
    const endMs = Math.round(cue.endMs);
    if (endMs <= startMs) {
      return invalidTrack('Cue timestamps collapse after millisecond normalization.');
    }

    const metadata = mergeMetadata(cue.metadata, cue.sourceId);
    const text = normalizeCueText(cue.text);
    const baseCueId = createStableCueId(
      trackId,
      startMs,
      endMs,
      text,
      cue.sourceId,
    );
    const occurrence = (cueIdOccurrences.get(baseCueId) ?? 0) + 1;
    cueIdOccurrences.set(baseCueId, occurrence);
    const normalizedCue: SubtitleCue = {
      id: occurrence === 1 ? baseCueId : `${baseCueId}:${occurrence}`,
      startMs,
      endMs,
      text,
      ...(cue.settings === undefined
        ? {}
        : { settings: freezeRecord(cue.settings) }),
      ...(metadata === undefined ? {} : { metadata }),
    };
    cues.push(Object.freeze(normalizedCue));
  }

  const language: SubtitleLanguage = Object.freeze({ ...draft.language, tag: languageTag });
  const track: SubtitleTrack = {
    id: trackId,
    format: draft.format,
    language,
    cues: Object.freeze(cues),
    ...(draft.metadata === undefined
      ? {}
      : { metadata: freezeRecord(draft.metadata) }),
  };

  return ok(Object.freeze(track));
}

function createStableCueId(
  trackId: string,
  startMs: number,
  endMs: number,
  text: string,
  sourceId?: string,
): string {
  const identity = `${trackId}\u0000${sourceId?.trim() ?? ''}\u0000${startMs}\u0000${endMs}\u0000${text}`;
  let hash = 0x811c9dc5;

  for (let position = 0; position < identity.length; position += 1) {
    hash ^= identity.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193);
  }

  return `${trackId}:cue:${(hash >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function mergeMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
  sourceId: string | undefined,
): Readonly<Record<string, string>> | undefined {
  const normalizedSourceId = sourceId?.trim();
  if (metadata === undefined && !normalizedSourceId) return undefined;

  return freezeRecord({
    ...(metadata ?? {}),
    ...(normalizedSourceId ? { sourceId: normalizedSourceId } : {}),
  });
}

function freezeRecord(
  record: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze({ ...record });
}

function invalidTrack(message: string): Result<never, SubtitleNormalizationError> {
  return err({
    code: 'invalid_subtitle_track',
    message,
    retryable: false,
  });
}
