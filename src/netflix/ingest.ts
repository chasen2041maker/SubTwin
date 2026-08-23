import { err, type AppError, type Result } from '../shared/result';
import { parseTtml } from '../subtitles/ttml';
import type {
  SubtitleLanguageKind,
  SubtitleParseError,
  SubtitleTrack,
} from '../subtitles/types';
import { parseWebVtt } from '../subtitles/webvtt';
import { normalizeNetflixLanguageTag } from './adapter';
import {
  MAX_NETFLIX_BRIDGE_BYTES,
  type NetflixTimedTextPayload,
  type NetflixTrackKind,
} from './bridge';

const SAFE_TRACK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESOURCE_ID = /^tt_[a-f0-9]{16}$/u;

export interface NetflixTimedTextIdentity {
  readonly titleId: string;
  readonly resourceId: string;
  readonly trackId: string;
  readonly languageTag: string;
  readonly kind: NetflixTrackKind;
}

export type NetflixTimedTextIngestError =
  | AppError<
      | 'netflix_invalid_timed_text_identity'
      | 'netflix_invalid_timed_text_payload'
      | 'netflix_timed_text_identity_mismatch'
    >
  | SubtitleParseError;

export function parseNetflixTimedTextPayload(
  payload: unknown,
  identity: NetflixTimedTextIdentity,
): Result<SubtitleTrack, NetflixTimedTextIngestError> {
  if (!isTimedTextPayload(payload)) {
    return ingestError(
      'netflix_invalid_timed_text_payload',
      'The Netflix timed-text payload is invalid.',
    );
  }

  const language = normalizeNetflixLanguageTag(identity.languageTag);
  if (
    !SAFE_TRACK_ID.test(identity.titleId) ||
    !RESOURCE_ID.test(identity.resourceId) ||
    !SAFE_TRACK_ID.test(identity.trackId) ||
    language === null ||
    (identity.kind !== 'subtitle' && identity.kind !== 'closed-caption')
  ) {
    return ingestError(
      'netflix_invalid_timed_text_identity',
      'The Netflix timed-text identity is invalid.',
    );
  }

  if (
    payload.titleId !== identity.titleId ||
    payload.resourceId !== identity.resourceId
  ) {
    return ingestError(
      'netflix_timed_text_identity_mismatch',
      'The Netflix timed-text payload belongs to another resource.',
    );
  }

  const payloadLanguage = normalizeNetflixLanguageTag(payload.language);
  if (
    payload.trackId !== identity.trackId ||
    payloadLanguage === null ||
    payloadLanguage.category !== language.category ||
    payloadLanguage.tag !== language.tag
  ) {
    return ingestError(
      'netflix_timed_text_identity_mismatch',
      'The Netflix timed-text payload belongs to another resource.',
    );
  }

  const options = {
    trackId: identity.trackId,
    language: {
      tag: language.tag,
      kind: toSubtitleLanguageKind(identity.kind),
    },
  } as const;

  return payload.format === 'webvtt'
    ? parseWebVtt(payload.body, options)
    : parseTtml(payload.body, options);
}

function isTimedTextPayload(value: unknown): value is NetflixTimedTextPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 7 &&
    keys.every((key) => [
      'body',
      'format',
      'language',
      'resourceId',
      'trackId',
      'titleId',
      'type',
    ].includes(key)) &&
    record.type === 'timed-text' &&
    typeof record.titleId === 'string' &&
    SAFE_TRACK_ID.test(record.titleId) &&
    typeof record.resourceId === 'string' &&
    RESOURCE_ID.test(record.resourceId) &&
    typeof record.trackId === 'string' &&
    SAFE_TRACK_ID.test(record.trackId) &&
    typeof record.language === 'string' &&
    normalizeNetflixLanguageTag(record.language) !== null &&
    (record.format === 'ttml' || record.format === 'webvtt') &&
    typeof record.body === 'string' &&
    record.body.length <= MAX_NETFLIX_BRIDGE_BYTES &&
    new TextEncoder().encode(record.body).byteLength <=
      MAX_NETFLIX_BRIDGE_BYTES
  );
}

function toSubtitleLanguageKind(
  kind: NetflixTrackKind,
): SubtitleLanguageKind {
  return kind === 'closed-caption' ? 'captions' : 'subtitles';
}

function ingestError<Code extends NetflixTimedTextIngestError['code']>(
  code: Code,
  message: string,
): Result<never, Extract<NetflixTimedTextIngestError, { code: Code }>> {
  return err({ code, message, retryable: false }) as Result<
    never,
    Extract<NetflixTimedTextIngestError, { code: Code }>
  >;
}
