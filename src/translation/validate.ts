import { err, ok } from '../shared/result';
import type { Result } from '../shared/result';
import type {
  TranslatedCue,
  TranslationBatch,
  TranslationError,
  TranslationRequest,
} from './types';

const MAX_TRANSLATION_LENGTH = 16_384;
const MAX_TRANSLATION_EXPANSION = 4;
const MIN_REASONABLE_TRANSLATION_LIMIT = 128;
const EXPLANATION_PREFIX =
  /^(?:translation|translated text|explanation|note|翻译|译文|说明|注)\s*[:：]/iu;

export function validateDeepSeekPayload(
  request: TranslationRequest,
  input: unknown,
): Result<TranslationBatch, TranslationError> {
  if (!isRecord(input) || !hasExactlyKeys(input, ['translations'])) {
    return invalidResponse();
  }

  if (!Array.isArray(input.translations)) return invalidResponse();
  const expected = new Map(request.cues.map((cue) => [cue.id, cue.text]));
  const candidatesById = new Map<string, unknown[]>();
  const translations: TranslatedCue[] = [];

  for (const candidate of input.translations) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      !expected.has(candidate.id)
    ) {
      return invalidResponse();
    }
    const existing = candidatesById.get(candidate.id) ?? [];
    existing.push(candidate);
    candidatesById.set(candidate.id, existing);
  }

  const retryCueIds: string[] = [];
  for (const cue of request.cues) {
    const candidates = candidatesById.get(cue.id) ?? [];
    if (candidates.length !== 1) {
      retryCueIds.push(cue.id);
      continue;
    }
    const candidate = candidates[0];
    if (
      !isRecord(candidate) ||
      !hasExactlyKeys(candidate, ['id', 'text']) ||
      typeof candidate.text !== 'string' ||
      !isValidTranslatedText(candidate.text, cue.text) ||
      EXPLANATION_PREFIX.test(candidate.text.trim())
    ) {
      retryCueIds.push(cue.id);
      continue;
    }
    if (
      isUnchangedTranslation(candidate.text, cue.text) &&
      !isLikelyPassThroughSource(cue.text)
    ) {
      retryCueIds.push(cue.id);
      continue;
    }
    translations.push({ cueId: cue.id, text: candidate.text.trim() });
  }

  return ok({
    translations,
    retryCueIds,
  });
}

export function validateGoogleFreePayload(
  sourceText: string,
  cueId: string,
  input: unknown,
): Result<TranslationBatch, TranslationError> {
  if (!Array.isArray(input) || !Array.isArray(input[0])) {
    return invalidResponse();
  }

  const translatedSegments: string[] = [];
  for (const segment of input[0]) {
    if (
      !Array.isArray(segment) ||
      typeof segment[0] !== 'string' ||
      segment[0].trim().length === 0
    ) {
      return invalidResponse();
    }
    translatedSegments.push(segment[0]);
  }

  if (translatedSegments.length === 0) return invalidResponse();
  const text = translatedSegments.join('').trim();
  if (!isValidTranslatedText(text, sourceText)) return invalidResponse();
  if (
    isUnchangedTranslation(text, sourceText) &&
    !isLikelyPassThroughSource(sourceText)
  ) {
    return ok({
      translations: [],
      retryCueIds: [cueId],
    });
  }

  return ok({
    translations: [{ cueId, text }],
    retryCueIds: [],
  });
}

function isValidTranslatedText(text: string, sourceText: string): boolean {
  const normalized = text.trim();
  const source = sourceText.trim();
  const reasonableLimit = Math.min(
    MAX_TRANSLATION_LENGTH,
    Math.max(
      MIN_REASONABLE_TRANSLATION_LIMIT,
      source.length * MAX_TRANSLATION_EXPANSION + 32,
    ),
  );
  const comparable = normalizeComparableText(normalized);
  return (
    normalized.length > 0 &&
    normalized.length <= reasonableLimit &&
    comparable.length > 0
  );
}

function isUnchangedTranslation(text: string, sourceText: string): boolean {
  return normalizeComparableText(text) === normalizeComparableText(sourceText);
}

/**
 * Some subtitle cues are identifiers, names, acronyms or numeric tokens that a
 * translator should legitimately preserve. Treating those as provider failures
 * can otherwise disable useful translation after a perfectly valid response.
 */
function isLikelyPassThroughSource(sourceText: string): boolean {
  const source = sourceText.trim();
  if (source.length === 0) return false;
  if (!/[A-Za-z]/u.test(source)) return true;
  if (/^(?:https?:\/\/|www\.|@)/iu.test(source)) return true;
  if (/^[A-Z0-9][A-Z0-9._:/+#-]{0,31}$/u.test(source)) return true;
  if (/^[A-Z][A-Za-z0-9.'’_-]{1,31}$/u.test(source) && !/\s/u.test(source)) {
    return true;
  }
  return false;
}

function normalizeComparableText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function invalidResponse(): Result<never, TranslationError> {
  return err({
    code: 'invalid_response',
    message: 'Translation provider returned an invalid response.',
    retryable: false,
  });
}
