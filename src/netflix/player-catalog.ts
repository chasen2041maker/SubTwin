import type { NetflixCatalogPayload, NetflixCatalogTrackDescriptor } from './bridge';
import { err, ok, type AppError, type Result } from '../shared/result';

export const MAX_NETFLIX_PLAYER_SESSIONS = 64;
export const MAX_NETFLIX_PLAYER_TRACKS = 256;

export type NetflixPlayerCatalogErrorCode =
  | 'netflix_player_api_failed'
  | 'netflix_player_api_unavailable'
  | 'netflix_player_catalog_conflict'
  | 'netflix_player_catalog_failed'
  | 'netflix_player_catalog_invalid'
  | 'netflix_player_catalog_too_large'
  | 'netflix_player_session_failed'
  | 'netflix_player_session_invalid'
  | 'netflix_player_session_unavailable';

export type NetflixPlayerCatalogError = AppError<NetflixPlayerCatalogErrorCode>;

const LANGUAGE_FIELDS = [
  'bcp47',
  'language',
  'languageCode',
  'bcp47Tag',
] as const;
const ID_FIELDS = [
  'trackId',
  'id',
  'new_track_id',
  'downloadableId',
] as const;
const KIND_FIELDS = ['kind', 'trackType', 'rawTrackType', 'type'] as const;
const NONE_FIELDS = ['isNoneTrack', 'isNone', 'none'] as const;
const FORCED_FIELDS = [
  'isForcedNarrative',
  'forcedNarrative',
  'isForced',
  'forced',
] as const;
const CLOSED_CAPTION_FIELDS = [
  'isClosedCaption',
  'isCC',
  'closedCaption',
] as const;
const SUBTITLE_FIELDS = ['isSubtitle'] as const;

type TrackParseResult =
  | { readonly kind: 'excluded' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'track';
      readonly value: NetflixCatalogTrackDescriptor;
    };

/**
 * Reads Netflix's live MAIN-world player API without changing player state.
 * A successful result represents the complete text-track list and is therefore
 * the only observation produced by this module that may be authoritative.
 */
export function readNetflixPlayerCatalog(
  target: unknown = globalThis,
): Result<NetflixCatalogPayload, NetflixPlayerCatalogError> {
  let videoPlayer: Readonly<Record<string, unknown>>;
  try {
    const playerApp = nestedRecord(target, [
      'netflix',
      'appContext',
      'state',
      'playerApp',
    ]);
    if (playerApp === null || typeof playerApp.getAPI !== 'function') {
      return playerCatalogError('netflix_player_api_unavailable');
    }
    const api = Reflect.apply(playerApp.getAPI, playerApp, []) as unknown;
    if (!isRecord(api) || !isRecord(api.videoPlayer)) {
      return playerCatalogError('netflix_player_api_unavailable');
    }
    videoPlayer = api.videoPlayer;
  } catch {
    return playerCatalogError('netflix_player_api_failed');
  }

  let rawSessionIds: unknown;
  try {
    if (typeof videoPlayer.getAllPlayerSessionIds !== 'function') {
      return playerCatalogError('netflix_player_api_unavailable');
    }
    rawSessionIds = Reflect.apply(
      videoPlayer.getAllPlayerSessionIds,
      videoPlayer,
      [],
    ) as unknown;
  } catch {
    return playerCatalogError('netflix_player_session_failed');
  }
  if (!Array.isArray(rawSessionIds) || rawSessionIds.length > MAX_NETFLIX_PLAYER_SESSIONS) {
    return playerCatalogError('netflix_player_session_invalid');
  }

  const sessionIds = uniqueValidSessionIds(rawSessionIds);
  const sessionId =
    sessionIds.find((candidate) => candidate.toLowerCase().includes('watch')) ??
    sessionIds[0];
  if (sessionId === undefined) {
    return playerCatalogError('netflix_player_session_unavailable');
  }

  let player: Readonly<Record<string, unknown>>;
  try {
    if (typeof videoPlayer.getVideoPlayerBySessionId !== 'function') {
      return playerCatalogError('netflix_player_api_unavailable');
    }
    const candidate = Reflect.apply(
      videoPlayer.getVideoPlayerBySessionId,
      videoPlayer,
      [sessionId],
    ) as unknown;
    if (!isRecord(candidate)) {
      return playerCatalogError('netflix_player_session_unavailable');
    }
    player = candidate;
  } catch {
    return playerCatalogError('netflix_player_session_failed');
  }

  let rawMovieId: unknown;
  let rawTracks: unknown;
  try {
    if (
      typeof player.getMovieId !== 'function' ||
      typeof player.getTextTrackList !== 'function'
    ) {
      return playerCatalogError('netflix_player_catalog_invalid');
    }
    rawMovieId = Reflect.apply(player.getMovieId, player, []) as unknown;
    rawTracks = Reflect.apply(player.getTextTrackList, player, []) as unknown;
  } catch {
    return playerCatalogError('netflix_player_catalog_failed');
  }

  const titleId = sanitizeTitleId(rawMovieId);
  if (titleId === null || !Array.isArray(rawTracks)) {
    return playerCatalogError('netflix_player_catalog_invalid');
  }
  if (rawTracks.length > MAX_NETFLIX_PLAYER_TRACKS) {
    return playerCatalogError('netflix_player_catalog_too_large');
  }

  const tracks = new Map<string, NetflixCatalogTrackDescriptor>();
  try {
    for (let index = 0; index < rawTracks.length; index += 1) {
      const parsed = sanitizeTrack(rawTracks[index], index);
      if (parsed.kind === 'excluded') continue;
      if (parsed.kind === 'invalid') {
        return playerCatalogError('netflix_player_catalog_invalid');
      }

      const previous = tracks.get(parsed.value.id);
      if (
        previous !== undefined &&
        (previous.language !== parsed.value.language ||
          previous.kind !== parsed.value.kind)
      ) {
        return playerCatalogError('netflix_player_catalog_conflict');
      }
      tracks.set(parsed.value.id, parsed.value);
    }
  } catch {
    return playerCatalogError('netflix_player_catalog_failed');
  }

  return ok({
    type: 'catalog',
    titleId,
    authority: 'authoritative',
    tracks: [...tracks.values()],
  });
}

function sanitizeTrack(value: unknown, index: number): TrackParseResult {
  if (!isRecord(value)) return { kind: 'invalid' };

  const enumValues = ownStringValues(value, KIND_FIELDS);
  if (enumValues === null) return { kind: 'invalid' };
  const normalizedEnums = enumValues.map(normalizeEnum);
  const noneFlag = ownBooleanFlag(value, NONE_FIELDS);
  const forcedFlag = ownBooleanFlag(value, FORCED_FIELDS);
  if (noneFlag === null || forcedFlag === null) return { kind: 'invalid' };
  if (
    noneFlag ||
    forcedFlag ||
    normalizedEnums.some(isNoneEnum) ||
    normalizedEnums.some(isForcedEnum)
  ) {
    return { kind: 'excluded' };
  }

  const language = sanitizeLanguage(value);
  if (language === null) return { kind: 'invalid' };
  const kind = sanitizeKind(value, normalizedEnums);
  if (kind === null) return { kind: 'invalid' };

  const safeId = firstSafeOpaqueId(value);
  const id = safeId ?? `track-${hash64(`${language}\u001f${kind}\u001f${index}`)}`;
  return { kind: 'track', value: { id, language, kind } };
}

function sanitizeLanguage(value: Readonly<Record<string, unknown>>): string | null {
  const candidates: string[] = [];
  for (const field of LANGUAGE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const raw = value[field];
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    const normalized = raw.trim().replaceAll('_', '-');
    if (
      normalized.length > 35 ||
      !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(normalized)
    ) {
      return null;
    }
    candidates.push(normalized);
  }
  if (candidates.length === 0) return null;
  const canonical = candidates[0];
  if (
    canonical === undefined ||
    candidates.some((candidate) => candidate.toLowerCase() !== canonical.toLowerCase())
  ) {
    return null;
  }
  return canonical;
}

function sanitizeKind(
  value: Readonly<Record<string, unknown>>,
  normalizedEnums: readonly string[],
): NetflixCatalogTrackDescriptor['kind'] | null {
  const candidates = new Set<NetflixCatalogTrackDescriptor['kind']>();
  for (const candidate of normalizedEnums) {
    if (isSubtitleEnum(candidate)) candidates.add('subtitle');
    if (isClosedCaptionEnum(candidate)) candidates.add('closed-caption');
  }

  const closedCaption = ownBooleanFlag(value, CLOSED_CAPTION_FIELDS);
  const subtitle = ownBooleanFlag(value, SUBTITLE_FIELDS);
  if (closedCaption === null || subtitle === null) return null;
  if (closedCaption) candidates.add('closed-caption');
  if (subtitle) candidates.add('subtitle');

  return candidates.size === 1 ? [...candidates][0] ?? null : null;
}

function firstSafeOpaqueId(value: Readonly<Record<string, unknown>>): string | null {
  for (const field of ID_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const raw = value[field];
    if (typeof raw === 'string') {
      const candidate = raw.trim();
      if (isOpaqueId(candidate)) return candidate;
    } else if (
      typeof raw === 'number' &&
      Number.isSafeInteger(raw) &&
      raw >= 0
    ) {
      return String(raw);
    }
  }
  return null;
}

function sanitizeTitleId(value: unknown): string | null {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 512) return null;
  return isOpaqueId(candidate) ? candidate : `title-${hash64(candidate)}`;
}

function uniqueValidSessionIds(values: readonly unknown[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const candidate = value.trim();
    if (
      candidate.length === 0 ||
      candidate.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(candidate) ||
      seen.has(candidate)
    ) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function ownStringValues(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): readonly string[] | null {
  const values: string[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    const candidate = value[field];
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return null;
    }
    values.push(candidate.trim());
  }
  return values;
}

function ownBooleanFlag(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean | null {
  let enabled = false;
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    const candidate = value[field];
    if (typeof candidate !== 'boolean') return null;
    enabled ||= candidate;
  }
  return enabled;
}

function normalizeEnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/gu, '');
}

function isNoneEnum(value: string): boolean {
  return value === 'none' || value === 'off' || value === 'disabled';
}

function isForcedEnum(value: string): boolean {
  return value.includes('forced');
}

function isSubtitleEnum(value: string): boolean {
  return value === 'subtitle' || value === 'subtitles';
}

function isClosedCaptionEnum(value: string): boolean {
  return (
    value === 'caption' ||
    value === 'captions' ||
    value === 'cc' ||
    value === 'closecaption' ||
    value === 'closecaptions' ||
    value === 'closedcaption' ||
    value === 'closedcaptions'
  );
}

function nestedRecord(
  root: unknown,
  path: readonly string[],
): Readonly<Record<string, unknown>> | null {
  let current = root;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

function isOpaqueId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hash64(value: string): string {
  return `${fnv1a(value, 0x811c9dc5)}${fnv1a(
    [...value].reverse().join(''),
    0x9e3779b9,
  )}`;
}

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function playerCatalogError(
  code: NetflixPlayerCatalogErrorCode,
): Result<never, NetflixPlayerCatalogError> {
  return err({
    code,
    message: 'The Netflix player catalog was unavailable or failed strict validation.',
    retryable: false,
  });
}
