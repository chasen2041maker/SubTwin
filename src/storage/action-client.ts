import {
  parseMessageEnvelope,
  type MessageFor,
  type MessageType,
} from '../shared/messages';

type BackgroundSettingsResultType =
  | 'settings/cache-clear-result'
  | 'settings/deepseek-test-result'
  | 'settings/enabled-set-result'
  | 'settings/options-update-result'
  | 'settings/private-get-result'
  | 'settings/public-get-result';

export function parseDeepSeekTestActionResponse(
  candidate: unknown,
  requestId: string,
): MessageFor<'settings/deepseek-test-result'> | null {
  return parseBackgroundActionResponse(
    candidate,
    requestId,
    'settings/deepseek-test-result',
  );
}

export function parseCacheClearActionResponse(
  candidate: unknown,
  requestId: string,
): MessageFor<'settings/cache-clear-result'> | null {
  return parseBackgroundActionResponse(
    candidate,
    requestId,
    'settings/cache-clear-result',
  );
}

export function parseOptionsUpdateActionResponse(
  candidate: unknown,
  requestId: string,
): MessageFor<'settings/options-update-result'> | null {
  return parseBackgroundActionResponse(
    candidate,
    requestId,
    'settings/options-update-result',
  );
}

export function parsePublicSettingsActionResponse(
  candidate: unknown,
  requestId: string,
): MessageFor<'settings/public-get-result'> | null {
  return parseBackgroundActionResponse(
    candidate,
    requestId,
    'settings/public-get-result',
  );
}

export function parsePrivateSettingsActionResponse(
  candidate: unknown,
  requestId: string,
): MessageFor<'settings/private-get-result'> | null {
  return parseBackgroundActionResponse(
    candidate,
    requestId,
    'settings/private-get-result',
  );
}

export function parseEnabledSetActionResponse(
  candidate: unknown,
  requestId: string,
): MessageFor<'settings/enabled-set-result'> | null {
  return parseBackgroundActionResponse(
    candidate,
    requestId,
    'settings/enabled-set-result',
  );
}

function parseBackgroundActionResponse<Type extends BackgroundSettingsResultType>(
  candidate: unknown,
  requestId: string,
  expectedType: Type,
): MessageFor<Type> | null {
  if (!isRecord(candidate) || !hasExactlyKeys(candidate, ['ok', 'value'])) {
    return null;
  }
  if (candidate.ok !== true) return null;
  const parsed = parseMessageEnvelope(candidate.value);
  if (
    !parsed.ok ||
    parsed.value.source !== 'background' ||
    parsed.value.type !== expectedType ||
    parsed.value.id !== `${requestId}:background`
  ) return null;
  return parsed.value as MessageFor<Type>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}
