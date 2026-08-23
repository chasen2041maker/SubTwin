import { ok } from '../src/shared/result';
import {
  createMessage,
  parseMessageEnvelope,
} from '../src/shared/messages';

export default defineBackground({
  type: 'module',
  main() {
    browser.runtime.onMessage.addListener((candidate: unknown) => {
      const parsed = parseMessageEnvelope(candidate);

      if (!parsed.ok) {
        return Promise.resolve(parsed);
      }

      if (parsed.value.type !== 'system/health-check') {
        return undefined;
      }

      return Promise.resolve(
        ok(
          createMessage({
            id: `${parsed.value.id}:background`,
            source: 'background',
            type: 'system/health-response',
            payload: {
              requestId: parsed.value.id,
              ready: true,
            },
          }),
        ),
      );
    });
  },
});
