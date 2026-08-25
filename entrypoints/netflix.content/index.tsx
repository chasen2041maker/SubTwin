import {
  bufferEarlyCatalogPayload,
  bufferNetflixTimedTextPayload,
  createNetflixContentSession,
  type NetflixContentSession,
} from '../../src/app/netflix-content-session';
import { createExtensionTranslationTaskClient } from '../../src/app/extension-task-client';
import {
  createPageControlCoordinator,
  type PageControlCoordinator,
  type PageControlPersistenceResult,
  type PageControlSettingsMutation,
} from '../../src/app/page-control-coordinator';
import {
  advancePageSubtitlePipeline,
  createPageSubtitlePipeline,
  type PageSubtitlePipelineStage,
} from '../../src/app/page-subtitle-pipeline';
import {
  parsePageSettingsUpdateResponse,
  parseRuntimeSettingsPush,
  parseRuntimeSettingsResponse,
  type RuntimeSettingsPush,
} from '../../src/app/runtime-settings-client';
import type { RuntimeStatus } from '../../src/app/status';
import type { NetflixBridgePayload } from '../../src/netflix/bridge';
import { createNativeSubtitleClock } from '../../src/netflix/native-subtitle-clock';
import { createNativeSubtitleVisibility } from '../../src/netflix/native-subtitle-visibility';
import {
  readNetflixPageMetadata,
  summarizeNetflixCatalog,
} from '../../src/netflix/page-metadata';
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
import {
  mountPageControlSurface,
  type PageControlSurfaceModel,
  type PageControlSurfaceMount,
} from '../../src/renderer/PageControlSurface';
import { createMessage } from '../../src/shared/messages';
import {
  DEFAULT_SETTINGS,
  type RuntimeSettingsState,
} from '../../src/storage/schema';

const MAX_EARLY_CATALOGS = 2;
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
    let pageControlMount: PageControlSurfaceMount | undefined;
    let pageControlCoordinator: PageControlCoordinator | undefined;
    let latestPageControlModel: PageControlSurfaceModel | undefined;
    let metadataTimer: number | undefined;
    let latestSettingsPush: RuntimeSettingsPush | undefined;
    let earlyPayloads: NetflixBridgePayload[] = [];
    let latestSubtitlePipeline = createPageSubtitlePipeline(bridgeGeneration);
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
      pageControlCoordinator?.updateStatus(status);
      safeSend(createMessage({
        id: nextMessageId('runtime-status'),
        source: 'content',
        type: 'runtime/status-set',
        payload: status,
      }));
    };

    const updateSubtitlePipeline = (
      stage: PageSubtitlePipelineStage,
      message: string,
      episodeGeneration = latestSubtitlePipeline.episodeGeneration,
    ): void => {
      const next = advancePageSubtitlePipeline(latestSubtitlePipeline, {
        bridgeGeneration,
        episodeGeneration,
        stage,
        message,
      });
      if (next === latestSubtitlePipeline) return;
      latestSubtitlePipeline = next;
      pageControlCoordinator?.updatePipeline(next.message);
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
      if (payload.type === 'diagnostic') {
        if (payload.code === 'metadata_candidate_observed') {
          updateSubtitlePipeline('metadata', '已捕获 Netflix 播放元数据响应');
        } else if (payload.code === 'metadata_response_accepted') {
          updateSubtitlePipeline('metadata', '正在读取 Netflix 播放元数据');
        } else if (payload.code === 'metadata_json_parsed') {
          updateSubtitlePipeline('metadata', 'Netflix 播放元数据 JSON 已解析');
        } else if (payload.code === 'metadata_json_invalid') {
          updateSubtitlePipeline('metadata', 'Netflix 播放元数据不是有效 JSON');
        } else if (payload.code === 'metadata_body_timeout') {
          updateSubtitlePipeline('metadata', 'Netflix 播放元数据读取超时');
        } else if (payload.code === 'metadata_body_too_large') {
          updateSubtitlePipeline('metadata', 'Netflix 播放元数据超过安全上限');
        } else if (payload.code === 'metadata_body_read_failed') {
          updateSubtitlePipeline('metadata', 'Netflix 播放元数据读取失败');
        } else if (payload.code === 'metadata_body_unsupported') {
          updateSubtitlePipeline('metadata', 'Netflix 播放元数据响应不可读');
        } else if (payload.code === 'metadata_catalog_recognized') {
          updateSubtitlePipeline('metadata', 'Netflix 字幕元数据已识别');
        } else if (payload.code === 'metadata_catalog_unrecognized') {
          updateSubtitlePipeline('metadata', 'Netflix 元数据中未识别字幕目录');
        } else if (payload.code === 'metadata_xhr_json_unsupported') {
          updateSubtitlePipeline('metadata', 'Netflix 元数据使用 JSON XHR');
        } else if (payload.code === 'metadata_resources_extracted') {
          updateSubtitlePipeline('resources', '已提取 Netflix 字幕下载资源');
        } else if (payload.code === 'metadata_resource_extract_failed') {
          updateSubtitlePipeline('metadata', 'Netflix 字幕下载资源提取失败');
        } else if (payload.code === 'download_candidate_approved') {
          updateSubtitlePipeline('approved', 'Netflix 字幕下载资源已匹配');
        } else if (payload.code === 'download_candidate_unmatched') {
          updateSubtitlePipeline('resources', 'Netflix 字幕资源与当前目录不匹配');
        } else if (payload.code === 'download_started') {
          updateSubtitlePipeline('downloading', '正在下载 Netflix 字幕');
        } else if (payload.code === 'download_succeeded') {
          updateSubtitlePipeline('downloaded', '字幕已下载，等待解析');
        } else if (payload.code === 'display_unavailable') {
          updateSubtitlePipeline('failed', 'Netflix 字幕下载失败');
        }
      }
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
          .filter((candidate): candidate is Extract<
            NetflixBridgePayload,
            { type: 'timed-text' }
          > => candidate.type === 'timed-text');
        earlyPayloads = catalogs.concat(
          bufferNetflixTimedTextPayload(timedText, payload),
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
      updateSubtitlePipeline('waiting', '等待字幕数据');
      startBridge();
      startNativeClock();
    };

    const onRuntimeMessage = (candidate: unknown, sender: { id?: string }): void => {
      if (invalidated || sender.id !== browser.runtime.id) return;
      const push = parseRuntimeSettingsPush(candidate);
      if (push === null) return;
      latestSettingsPush = push;
      if (pageControlCoordinator !== undefined) {
        pageControlCoordinator.updateSettings(push.settings, {
          translationConfigurationChanged:
            push.translationConfigurationChanged,
        });
      } else {
        contentSession?.updateSettings(push.settings, {
          translationConfigurationChanged:
            push.translationConfigurationChanged,
        });
      }
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
        onVerticalOffsetChange: (verticalOffsetPercent) => {
          const appearance = latestPageControlModel?.settings.appearance;
          if (appearance === undefined) return;
          pageControlCoordinator?.setAppearance({
            ...appearance,
            verticalOffsetPercent,
          });
        },
      });
    } catch {
      nativeVisibility.restore();
      overlay = undefined;
    }
    const overlaySink = overlay ?? {
      render: () => false,
      setNativeSubtitlesHidden: () => undefined,
      setDragMode: () => undefined,
      clear: () => nativeVisibility.restore(),
      dispose: () => undefined,
    };
    pageControlCoordinator = createPageControlCoordinator({
      initialSettings: runtimeSettings,
      applySettings: (settings, updateOptions) => {
        contentSession?.updateSettings(settings, updateOptions);
      },
      persistSettings: persistPageSettings,
      render: (model) => {
        latestPageControlModel = model;
        overlay?.setNativeSubtitlesHidden(
          model.settings.enabled && !model.paused,
        );
        pageControlMount?.update(model);
      },
      schedule: (callback) => window.setTimeout(callback, 140),
      cancel: (handle) => window.clearTimeout(handle),
    });
    pageControlCoordinator.updatePipeline(latestSubtitlePipeline.message);
    try {
      pageControlMount = mountPageControlSurface({
        model: latestPageControlModel as PageControlSurfaceModel,
        onAppearanceChange: (appearance) =>
          pageControlCoordinator?.setAppearance(appearance),
        onEnabledChange: (enabled) =>
          pageControlCoordinator?.setEnabled(enabled),
        onExpandedChange: (expanded) => overlay?.setDragMode(expanded),
        onPausedChange: (paused) =>
          pageControlCoordinator?.setPaused(paused),
        onProviderChange: (provider) =>
          pageControlCoordinator?.setProvider(provider),
      });
    } catch {
      pageControlMount = undefined;
    }
    const refreshPageMetadata = (): void => {
      try {
        pageControlCoordinator?.updateMetadata(
          readNetflixPageMetadata(document as never),
        );
      } catch {
        // Page metadata is diagnostic-only and never affects subtitles.
      }
    };
    refreshPageMetadata();
    metadataTimer = window.setInterval(refreshPageMetadata, 1_000);
    const videoTicks = createVideoTickSource({
      document: documentFacade as never,
      createObserver,
      requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
      cancelAnimationFrame: (handle) =>
        window.cancelAnimationFrame(handle as number),
      now: () => performance.now(),
      onVideoRemount: () => {
        const watchTitleId = /^\/watch\/([A-Za-z0-9._:-]{1,128})(?:[/?#]|$)/u
          .exec(window.location.pathname)?.[1] ?? null;
        contentSession?.playerRemounted(watchTitleId);
      },
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
        if (state.state === 'active') {
          updateSubtitlePipeline('waiting', '等待字幕数据', state.generation);
        }
        safeSend(createMessage({
          id: nextMessageId('netflix-session'),
          source: 'content',
          type: 'netflix/session-state',
          payload: state,
        }));
      },
      onCatalogSummary: (summary) => {
        updateSubtitlePipeline(
          'catalog',
          '已读取 Netflix 字幕目录',
          summary.generation,
        );
        pageControlCoordinator?.updateCatalog(summarizeNetflixCatalog(summary));
        safeSend(createMessage({
          id: nextMessageId('netflix-catalog'),
          source: 'content',
          type: 'netflix/catalog-summary',
          payload: summary,
        }));
      },
      onBridgeRestart: restartBridge,
      onDiagnostic: (diagnostic) => {
        if (diagnostic.code === 'timed_text_received') {
          updateSubtitlePipeline('received', '字幕正文已到达');
        } else if (diagnostic.code === 'timed_text_accepted') {
          if (diagnostic.detail === 'dual') {
            updateSubtitlePipeline('accepted', '字幕已解析，可显示双语');
          } else {
            updateSubtitlePipeline('partial', '已解析一条字幕轨，等待另一条');
          }
        } else if (diagnostic.code === 'timed_text_descriptor_missing') {
          updateSubtitlePipeline('failed', '字幕轨匹配失败');
        } else if (diagnostic.code === 'timed_text_parse_failed') {
          updateSubtitlePipeline(
            'failed',
            `字幕解析失败：${diagnostic.detail ?? 'unknown'}`,
          );
        }
        console.info(
          '[SubTwin] Netflix timed-text ingest:',
          diagnostic.code,
          diagnostic.detail ?? '',
        );
      },
    });
    pageControlCoordinator.updateSettings(runtimeSettings);
    startClockForCurrentBridge();
    const buffered = earlyPayloads;
    earlyPayloads = [];
    for (const payload of buffered) contentSession.handlePayload(payload);
    if (
      latestSettingsPush !== undefined &&
      latestSettingsPush !== initialSettingsPush
    ) {
      pageControlCoordinator.updateSettings(latestSettingsPush.settings, {
        translationConfigurationChanged:
          latestSettingsPush.translationConfigurationChanged,
      });
    }

    disposeResources = () => {
      if (metadataTimer !== undefined) {
        window.clearInterval(metadataTimer);
        metadataTimer = undefined;
      }
      pageControlCoordinator?.dispose();
      pageControlCoordinator = undefined;
      pageControlMount?.dispose();
      pageControlMount = undefined;
      taskClient.dispose();
      videoTicks.dispose();
      try {
        overlay?.dispose();
      } finally {
        nativeVisibility.restore();
      }
      overlay = undefined;
    };

    async function persistPageSettings(
      mutation: PageControlSettingsMutation,
    ): Promise<PageControlPersistenceResult> {
      const requestId = nextMessageId('settings-page-update');
      const request = createMessage({
        id: requestId,
        source: 'content',
        type: 'settings/page-update',
        payload: mutation,
      });
      try {
        const response = await withTimeout(
          browser.runtime.sendMessage(request),
          SETTINGS_TIMEOUT_MS,
        );
        return parsePageSettingsUpdateResponse(response, requestId) === null
          ? { ok: false }
          : { ok: true };
      } catch {
        return { ok: false };
      }
    }

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
