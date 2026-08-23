import { parseNetflixTimedTextPayload } from '../../src/netflix/ingest';
import {
  createIsolatedNetflixBridge,
  type NetflixRuntimeWindow,
} from '../../src/netflix/runtime';
import { createMessage } from '../../src/shared/messages';
import type { SubtitleTrack } from '../../src/subtitles/types';

export default defineContentScript({
  matches: ['https://www.netflix.com/*'],
  runAt: 'document_start',
  noScriptStartedPostMessage: true,
  main(ctx) {
    const nonce = createSessionNonce();
    const generation = createGeneration();
    const sessionId = `nfs_${nonce.slice(0, 16)}`;
    const tracks = new Map<string, SubtitleTrack>();

    const bridge = createIsolatedNetflixBridge({
      window: window as unknown as NetflixRuntimeWindow,
      nonce,
      generation,
      onPayload(payload) {
        if (payload.type === 'catalog') {
          safeSend(
            createMessage({
              id: `${sessionId}:catalog:${generation}`,
              source: 'content',
              type: 'netflix/catalog-summary',
              payload: {
                sessionId,
                generation,
                authority: payload.authority,
                tracks: payload.tracks,
              },
            }),
          );
          return;
        }
        if (payload.type !== 'timed-text') return;

        const parsed = parseNetflixTimedTextPayload(payload, {
          resourceId: payload.resourceId,
          trackId: payload.trackId,
          languageTag: payload.language,
          kind: 'subtitle',
        });
        if (parsed.ok) {
          tracks.set(parsed.value.id, parsed.value);
        }
      },
    });

    const started = bridge.start();
    safeSend(
      createMessage({
        id: `${sessionId}:probe:${generation}`,
        source: 'content',
        type: 'netflix/probe-status',
        payload: {
          sessionId,
          generation,
          status: started.ok ? 'connected' : 'unsupported',
        },
      }),
    );
    ctx.onInvalidated(() => {
      bridge.dispose();
      tracks.clear();
      safeSend(
        createMessage({
          id: `${sessionId}:disposed:${generation}`,
          source: 'content',
          type: 'netflix/probe-status',
          payload: { sessionId, generation, status: 'disposed' },
        }),
      );
    });
  },
});

function createSessionNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function createGeneration(): number {
  const random = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
  return Date.now() * 1_024 + (random & 1_023);
}

function safeSend(message: unknown): void {
  try {
    void browser.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // An extension reload must not affect Netflix playback.
  }
}
