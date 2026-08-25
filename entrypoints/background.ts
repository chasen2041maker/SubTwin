import {
  createBackgroundMessageRouter,
  createNetflixSessionRegistry,
} from '../src/app/background-runtime';
import { RUNTIME_STATUS_STORAGE_KEY } from '../src/app/status';
import { createMessage } from '../src/shared/messages';
import { createBackgroundTranslationHandler } from '../src/translation/background';
import { TranslationCache } from '../src/translation/cache';
import { createSettingsActionHandler } from '../src/storage/background-actions';
import { restrictStorageToTrustedContexts } from '../src/storage/access';
import { SettingsStore } from '../src/storage/settings';

const NETFLIX_SESSION_REGISTRY_STORAGE_KEY = 'netflixSessionRegistryV1';

export default defineBackground({
  type: 'module',
  main() {
    const cache = new TranslationCache();
    const settingsStore = new SettingsStore();
    const sessions = createNetflixSessionRegistry();
    let pushSequence = 0;
    let sessionPersistence = Promise.resolve();
    const persistSessionRegistry = async (): Promise<void> => {
      const snapshot = sessions.snapshot();
      const write = sessionPersistence.then(async () => {
        await browser.storage.session.set({
          [NETFLIX_SESSION_REGISTRY_STORAGE_KEY]: snapshot,
        });
      });
      sessionPersistence = write.catch(() => undefined);
      await write;
    };
    const ready = (async () => {
      await restrictStorageToTrustedContexts(browser.storage.local);
      await settingsStore.load();
      try {
        const stored = await browser.storage.session.get(
          NETFLIX_SESSION_REGISTRY_STORAGE_KEY,
        );
        sessions.restore(stored[NETFLIX_SESSION_REGISTRY_STORAGE_KEY]);
      } catch {
        // A fresh registry safely fails closed until content reports its state.
      }
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
      readCurrentEpisodeId: async () => sessions.readCurrentEpisodeId(),
    });
    const routeMessage = createBackgroundMessageRouter({
      runtimeId: browser.runtime.id,
      extensionBaseUrl: browser.runtime.getURL(''),
      sessionRegistry: sessions,
      loadSettings: () => settingsStore.load(),
      handleTranslation,
      handleSettingsAction,
      writeRuntimeStatus: async (status) => {
        await browser.storage.local.set({
          [RUNTIME_STATUS_STORAGE_KEY]: status,
        });
      },
      broadcastRuntimeSettings: async (
        settings,
        translationConfigurationChanged,
      ) => {
        const message = createMessage({
          id: `runtime-settings-push-${
            translationConfigurationChanged ? 'config' : 'display'
          }-${Date.now()}-${++pushSequence}`,
          source: 'background',
          type: 'runtime/settings-state',
          payload: settings,
        });
        const tabs = await browser.tabs.query({
          url: 'https://www.netflix.com/*',
        });
        await Promise.all(tabs.map(async (tab) => {
          if (tab.id === undefined) return;
          try {
            await browser.tabs.sendMessage(tab.id, message);
          } catch {
            // A Netflix tab without an active content script is expected.
          }
        }));
      },
      persistSessionRegistry,
    });
    browser.runtime.onMessage.addListener(async (candidate: unknown, sender) => {
      await ready;
      return routeMessage(candidate, sender);
    });
    browser.tabs.onRemoved.addListener((tabId) => {
      void ready.then(async () => {
        sessions.removeTab(tabId);
        try {
          await persistSessionRegistry();
        } catch {
          // The closed tab is already removed from the in-memory policy state.
        }
      });
    });
  },
});
