import { parseMessageEnvelope } from '../shared/messages';
import type { RuntimeSettingsState } from '../storage/schema';

export interface RuntimeSettingsPush {
  readonly settings: RuntimeSettingsState;
  readonly translationConfigurationChanged: boolean;
}

export function parseRuntimeSettingsResponse(
  candidate: unknown,
  requestId: string,
): RuntimeSettingsState | null {
  if (
    !isRecord(candidate) ||
    !hasExactlyKeys(candidate, ['ok', 'value']) ||
    candidate.ok !== true
  ) return null;
  const parsed = parseMessageEnvelope(candidate.value);
  if (
    !parsed.ok ||
    parsed.value.source !== 'background' ||
    parsed.value.type !== 'runtime/settings-state' ||
    parsed.value.id !== `${requestId}:background`
  ) return null;
  return parsed.value.payload;
}

export function parseRuntimeSettingsPush(
  candidate: unknown,
): RuntimeSettingsPush | null {
  const parsed = parseMessageEnvelope(candidate);
  if (
    !parsed.ok ||
    parsed.value.source !== 'background' ||
    parsed.value.type !== 'runtime/settings-state'
  ) return null;
  const match = /^runtime-settings-push-(config|display)-\d+-\d+$/u.exec(
    parsed.value.id,
  );
  if (match === null) return null;
  return {
    settings: parsed.value.payload,
    translationConfigurationChanged: match[1] === 'config',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every((key) => expected.includes(key));
}
