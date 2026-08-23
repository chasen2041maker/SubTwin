import { ok } from '../src/shared/result';
import {
  createMessage,
  parseMessageEnvelope,
} from '../src/shared/messages';
import { createBackgroundTranslationHandler } from '../src/translation/background';
import { TranslationCache } from '../src/translation/cache';
import { createSettingsActionHandler } from '../src/storage/background-actions';
import { restrictStorageToTrustedContexts } from '../src/storage/access';
import { SettingsStore } from '../src/storage/settings';
import {
  isTrustedSettingsSender,
  type SettingsPageAudience,
} from '../src/storage/trusted-sender';
import type { MessageType } from '../src/shared/messages';

export default defineBackground({
  type: 'module',
  main() {
    const cache = new TranslationCache();
    const settingsStore = new SettingsStore();
    const ready = (async () => {
      await restrictStorageToTrustedContexts(browser.storage.local);
      await settingsStore.load();
    })();
    const readSettings = async () => {
      const stored = await settingsStore.load();
      return {
        provider: stored.provider,
        deepseekApiKey: stored.deepseek.apiKey,
        deepseekModel: stored.deepseek.model,
      };
    };
    const handleTranslation = createBackgroundTranslationHandler({
      fetch: globalThis.fetch.bind(globalThis),
      cache,
      readSettings,
    });
    const handleSettingsAction = createSettingsActionHandler({
      fetch: globalThis.fetch.bind(globalThis),
      cache,
      settingsStore,
      readCurrentEpisodeId: async () => undefined,
    });

    browser.runtime.onMessage.addListener(async (candidate: unknown, sender) => {
      await ready;
      const boundary = parseMessageEnvelope(candidate);
      if (boundary.ok) {
        const audience = settingsActionAudience(
          boundary.value.type,
          boundary.value.source,
        );
        if (audience !== null) {
          if (!isTrustedSettingsSender(
            sender,
            audience,
            browser.runtime.id,
            browser.runtime.getURL(''),
          )) return undefined;
          return handleSettingsAction(boundary.value);
        }
      }

      const translation = await handleTranslation(candidate);
      if (translation !== undefined) return translation;

      const parsed = boundary;

      if (!parsed.ok) {
        return parsed;
      }

      if (parsed.value.type !== 'system/health-check') {
        return undefined;
      }

      return ok(
          createMessage({
            id: `${parsed.value.id}:background`,
            source: 'background',
            type: 'system/health-response',
            payload: {
              requestId: parsed.value.id,
              ready: true,
            },
          }),
        );
    });
  },
});

function settingsActionAudience(
  type: MessageType,
  source: string,
): SettingsPageAudience | null {
  if (
    type === 'settings/cache-clear' ||
    type === 'settings/deepseek-test' ||
    type === 'settings/options-update' ||
    type === 'settings/private-get'
  ) return 'options';
  if (type === 'settings/enabled-set' && (source === 'options' || source === 'popup')) {
    return source;
  }
  if (type === 'settings/public-get') {
    return 'popup';
  }
  return null;
}
