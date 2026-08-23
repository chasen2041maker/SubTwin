export type SettingsPageAudience = 'options' | 'popup';

export interface SettingsMessageSender {
  readonly id?: string;
  readonly tab?: unknown;
  readonly url?: string;
}

export function isTrustedSettingsSender(
  sender: SettingsMessageSender,
  audience: SettingsPageAudience,
  runtimeId: string,
  extensionBaseUrl: string,
): boolean {
  if (
    sender.id !== runtimeId ||
    typeof sender.url !== 'string'
  ) return false;

  try {
    const expected = new URL(`${audience}.html`, extensionBaseUrl);
    const actual = new URL(sender.url);
    return actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      actual.search === '' &&
      actual.hash === '';
  } catch {
    return false;
  }
}

export function trustedNetflixContentTabId(
  sender: SettingsMessageSender,
  runtimeId: string,
): number | null {
  if (sender.id !== runtimeId || typeof sender.url !== 'string') return null;

  const tab = asRecord(sender.tab);
  const tabId = tab?.id;
  if (
    typeof tabId !== 'number' ||
    !Number.isSafeInteger(tabId) ||
    tabId < 0
  ) return null;

  try {
    const url = new URL(sender.url);
    if (
      url.origin !== 'https://www.netflix.com' ||
      url.username !== '' ||
      url.password !== ''
    ) return null;
    return tabId;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
