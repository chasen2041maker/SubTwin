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
    sender.tab !== undefined ||
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
