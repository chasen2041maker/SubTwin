import { ok } from '../src/shared/result';
import {
  createMessage,
  parseMessageEnvelope,
} from '../src/shared/messages';
import { createBackgroundTranslationHandler } from '../src/translation/background';
import { TranslationCache } from '../src/translation/cache';

export default defineBackground({
  type: 'module',
  main() {
    const handleTranslation = createBackgroundTranslationHandler({
      fetch: globalThis.fetch.bind(globalThis),
      cache: new TranslationCache(),
      readSettings: async () => {
        const stored = await browser.storage.local.get([
          'translationProvider',
          'deepseekApiKey',
          'deepseekModel',
        ]);
        return {
          provider: stored.translationProvider ?? 'unset',
          deepseekApiKey: stored.deepseekApiKey,
          deepseekModel: stored.deepseekModel,
        };
      },
    });

    browser.runtime.onMessage.addListener(async (candidate: unknown) => {
      const translation = await handleTranslation(candidate);
      if (translation !== undefined) return translation;

      const parsed = parseMessageEnvelope(candidate);

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
