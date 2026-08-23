import {
  bufferEarlyCatalogPayload,
  createNetflixContentSession,
  type NetflixContentSession,
} from '../../src/app/netflix-content-session';
import { createExtensionTranslationTaskClient } from '../../src/app/extension-task-client';
import {
  parseRuntimeSettingsPush,
  parseRuntimeSettingsResponse,
  type RuntimeSettingsPush,
} from '../../src/app/runtime-settings-client';
import type { RuntimeStatus } from '../../src/app/status';
import type { NetflixBridgePayload } from '../../src/netflix/bridge';
import { createNativeSubtitleClock } from '../../src/netflix/native-subtitle-clock';
import { createNativeSubtitleVisibility } from '../../src/netflix/native-subtitle-visibility';
import {
  createIsolatedNetflixBridge,
  type IsolatedNetflixBridge,
  type NetflixRuntimeWindow,
} from '../../src/netflix/runtime';
import { createVideoTickSource } from '../../src/netflix/video-tick-source';
import {
  mountSubtitleOverlay,
  type SubtitleOverlayMount,
} from '../../src/renderer/SubtitleOverlay';
import { createMessage } from '../../src/shared/messages';
import {
  DEFAULT_SETTINGS,
  type RuntimeSettingsState,
} from '../../src/storage/schema';

const MAX_EARLY_CATALOGS = 2;
const MAX_EARLY_TIMED_TEXTS = 2;
const SETTINGS_TIMEOUT_MS = 4_000;

export default defineContentScript({
  matches: ['https://www.netflix.com/*'],
  runAt: 'document_start',
  noScriptStartedPostMessage: true,
  async main(ctx) {
    let invalidated = false;
    let messageSequence = 0;
    let bridgeGeneration = createGeneration();
    let bridgeNonce = createSessionNonce();
    let bridge: IsolatedNetflixBridge | undefined;
    let clock: ReturnType<typeof createNativeSubtitleClock> | undefined;
    let contentSession: NetflixContentSession | undefined;
    let overlay: SubtitleOverlayMount | undefined;
    let latestSettingsPush: RuntimeSettingsPush | undefined;
    let earlyPayloads: NetflixBridgePayload[] = [];
    let disposeRuntimeSettingsListener: (() => void) | undefined;
    let disposeResources: (() => void) | undefined;
    let startNativeClock: () => void = () => undefined;

    const nextMessageId = (prefix: string): string =>
      `${prefix}-${Date.now()}-${++messageSequence}`;

    const safeSend = (message: unknown): void => {
      try {
        void browser.runtime.sendMessage(message).catch(() => undefined);
      } catch {
        // Extension reloads and service-worker suspension must not affect playback.
      }
    };

    const publishStatus = (status: RuntimeStatus): void => {
      safeSend(createMessage({
        id: nextMessageId('runtime-status'),
        source: 'content',
        type: 'runtime/status-set',
        payload: status,
      }));
    };

    const publishProbeStatus = (
      status: 'connected' | 'disposed' | 'unsupported',
    ): void => {
      safeSend(createMessage({
        id: nextMessageId('netflix-probe'),
        source: 'content',
        type: 'netflix/probe-status',
        payload: {
          sessionId: bridgeSessionId(bridgeNonce),
          generation: bridgeGeneration,
          status,
        },
      }));
    };

    const handleBridgePayload = (payload: NetflixBridgePayload): void => {
      if (invalidated) return;
      if (contentSession !== undefined) {
        contentSession.handlePayload(payload);
        return;
      }
      if (payload.type === 'catalog') {
        earlyPayloads = bufferEarlyCatalogPayload(
          earlyPayloads,
          payload,
          MAX_EARLY_CATALOGS,
        );
        return;
      }
      if (payload.type === 'timed-text') {
        const catalogs = earlyPayloads.filter(({ type }) => type === 'catalog');
        const timedText = earlyPayloads
          .filter(({ type }) => type === 'timed-text')
          .filter((candidate) =>
            candidate.type === 'timed-text' &&
            candidate.resourceId !== payload.resourceId);
        earlyPayloads = catalogs.concat(
          [...timedText, payload].slice(-MAX_EARLY_TIMED_TEXTS),
        );
      }
    };

    const startBridge = (): void => {
      if (invalidated) return;
      bridge = createIsolatedNetflixBridge({
        window: window as unknown as NetflixRuntimeWindow,
        nonce: bridgeNonce,
        generation: bridgeGeneration,
        onPayload: handleBridgePayload,
      });
      const started = bridge.start();
      publishProbeStatus(started.ok ? 'connected' : 'unsupported');
    };

    const restartBridge = (): void => {
      if (invalidated) return;
      clock?.dispose();
      clock = undefined;
      bridge?.dispose();
      bridgeGeneration += 1;
      bridgeNonce = createSessionNonce();
      startBridge();
      startNativeClock();
    };

    const onRuntimeMessage = (candidate: unknown, sender: { id?: string }): void => {
      if (invalidated || sender.id !== browser.runtime.id) return;
      const push = parseRuntimeSettingsPush(candidate);
      if (push === null) return;
      latestSettingsPush = push;
      contentSession?.updateSettings(push.settings, {
        translationConfigurationChanged:
          push.translationConfigurationChanged,
      });
    };

    try {
      browser.runtime.onMessage.addListener(onRuntimeMessage);
      disposeRuntimeSettingsListener = () => {
        browser.runtime.onMessage.removeListener(onRuntimeMessage);
      };
    } catch {
      disposeRuntimeSettingsListener = undefined;
    }

    ctx.onInvalidated(() => {
      if (invalidated) return;
      invalidated = true;
      disposeRuntimeSettingsListener?.();
      disposeRuntimeSettingsListener = undefined;
      clock?.dispose();
      clock = undefined;
      contentSession?.dispose();
      contentSession = undefined;
      disposeResources?.();
      disposeResources = undefined;
      bridge?.dispose();
      bridge = undefined;
      publishProbeStatus('disposed');
      earlyPayloads = [];
    });

    startBridge();

    const [documentRoot, requestedSettings] = await Promise.all([
      waitForDocumentRoot(),
      requestRuntimeSettings(nextMessageId('runtime-settings')),
    ]);
    if (invalidated || documentRoot === null) {
      bridge?.dispose();
      publishProbeStatus('unsupported');
      return;
    }

    const initialSettingsPush = latestSettingsPush;
    const runtimeSettings = initialSettingsPush?.settings ??
      requestedSettings ?? safeDefaultRuntimeSettings();
    const documentFacade = {
      root: documentRoot,
      querySelector: (selector: string) =>
        document.querySelector<HTMLElement>(selector),
      querySelectorAll: (selector: string) =>
        document.querySelectorAll<HTMLElement>(selector),
    };
    const createObserver = (callback: () => void) =>
      new MutationObserver(() => callback());
    const nativeVisibility = createNativeSubtitleVisibility({
      document: documentFacade,
      createObserver,
    });
    try {
      overlay = mountSubtitleOverlay({
        document: document as never,
        nativeVisibility,
      });
    } catch {
      nativeVisibility.restore();
      overlay = undefined;
    }
    const overlaySink = overlay ?? {
      render: () => false,
      clear: () => nativeVisibility.restore(),
    };
    const videoTicks = createVideoTickSource({
      document: documentFacade as never,
      createObserver,
      requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
      cancelAnimationFrame: (handle) =>
        window.cancelAnimationFrame(handle as number),
      now: () => performance.now(),
      onVideoRemount: () => contentSession?.playerRemounted(),
    });
    const taskClient = createExtensionTranslationTaskClient({
      sendMessage: (message) => browser.runtime.sendMessage(message),
      isOnline: () => navigator.onLine,
      onRuntimeStatus: publishStatus,
    });

    const startClockForCurrentBridge = (): void => {
      if (invalidated) return;
      const generation = bridgeGeneration;
      clock = createNativeSubtitleClock({
        document: documentFacade,
        scheduler: {
          schedule: (callback) => window.requestAnimationFrame(() => callback()),
          cancel: (handle) => window.cancelAnimationFrame(handle as number),
        },
        createObserver,
        sessionId: bridgeSessionId(bridgeNonce),
        generation,
        onTick: (tick) => videoTicks.emitNative(tick),
        getCurrentTimeMs: () => videoTicks.currentTimeMs(),
        isGenerationCurrent: (candidate) => candidate === bridgeGeneration,
      });
      // A missing container is recoverable; the root observer will bind later.
      clock.start();
    };
    startNativeClock = startClockForCurrentBridge;

    contentSession = createNetflixContentSession({
      settings: runtimeSettings,
      tickSource: videoTicks,
      taskClient,
      overlay: overlaySink,
      status: { publish: publishStatus },
      onSessionState: (state) => {
        safeSend(createMessage({
          id: nextMessageId('netflix-session'),
          source: 'content',
          type: 'netflix/session-state',
          payload: state,
        }));
      },
      onCatalogSummary: (summary) => {
        safeSend(createMessage({
          id: nextMessageId('netflix-catalog'),
          source: 'content',
          type: 'netflix/catalog-summary',
          payload: summary,
        }));
      },
      onBridgeRestart: restartBridge,
    });
    startClockForCurrentBridge();
    const buffered = earlyPayloads;
    earlyPayloads = [];
    for (const payload of buffered) contentSession.handlePayload(payload);
    if (
      latestSettingsPush !== undefined &&
      latestSettingsPush !== initialSettingsPush
    ) {
      contentSession.updateSettings(latestSettingsPush.settings, {
        translationConfigurationChanged:
          latestSettingsPush.translationConfigurationChanged,
      });
    }

    disposeResources = () => {
      taskClient.dispose();
      videoTicks.dispose();
      try {
        overlay?.dispose();
      } finally {
        nativeVisibility.restore();
      }
      overlay = undefined;
    };

    async function requestRuntimeSettings(
      requestId: string,
    ): Promise<RuntimeSettingsState | null> {
      const request = createMessage({
        id: requestId,
        source: 'content',
        type: 'runtime/settings-get',
        payload: {},
      });
      try {
        const response = await withTimeout(
          browser.runtime.sendMessage(request),
          SETTINGS_TIMEOUT_MS,
        );
        return parseRuntimeSettingsResponse(response, requestId);
      } catch {
        return null;
      }
    }
  },
});

function safeDefaultRuntimeSettings(): RuntimeSettingsState {
  return {
    enabled: DEFAULT_SETTINGS.enabled,
    provider: 'unset',
    deepseekKeyReady: false,
    appearance: DEFAULT_SETTINGS.appearance,
  };
}

function waitForDocumentRoot(): Promise<Element | null> {
  if (document.documentElement !== null) {
    return Promise.resolve(document.documentElement);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled || document.documentElement === null) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      resolve(document.documentElement);
    };
    const observer = new MutationObserver(finish);
    observer.observe(document, { childList: true });
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve(document.documentElement);
    }, SETTINGS_TIMEOUT_MS);
    finish();
  });
}

function bridgeSessionId(nonce: string): string {
  return `bridge_${nonce.slice(0, 24)}`;
}

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

async function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('runtime_settings_timeout')),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('runtime_settings_failed'));
      },
    );
  });
}
