import type { RuntimeStatus } from './status';
import type {
  PageCatalogSummary,
  PageControlSurfaceModel,
  PagePlaybackMetadata,
} from '../renderer/PageControlSurface';
import type {
  RuntimeSettingsState,
  SubtitleAppearanceSettings,
  TranslationProviderSetting,
} from '../storage/schema';

export interface PageControlPersistenceResult {
  readonly ok: boolean;
  readonly settings?: RuntimeSettingsState;
}

export interface PageControlSettingsMutation {
  readonly enabled: boolean;
  readonly appearance: SubtitleAppearanceSettings;
  readonly provider: TranslationProviderSetting;
  readonly updateEnabled: boolean;
  readonly updateAppearance: boolean;
  readonly updateProvider: boolean;
}

export interface PageControlCoordinatorOptions {
  readonly initialSettings: RuntimeSettingsState;
  readonly applySettings: (
    settings: RuntimeSettingsState,
    options?: { readonly translationConfigurationChanged?: boolean },
  ) => void;
  readonly persistSettings: (
    mutation: PageControlSettingsMutation,
  ) => Promise<PageControlPersistenceResult>;
  readonly render: (model: PageControlSurfaceModel) => void;
  readonly schedule?: (callback: () => void) => number;
  readonly cancel?: (handle: number) => void;
}

export interface PageControlCoordinator {
  setAppearance(appearance: SubtitleAppearanceSettings): void;
  setEnabled(enabled: boolean): void;
  setPaused(paused: boolean): void;
  setProvider(provider: TranslationProviderSetting): void;
  updatePipeline(pipeline: string): void;
  updateCatalog(catalog: PageCatalogSummary): void;
  updateMetadata(metadata: PagePlaybackMetadata): void;
  updateSettings(
    settings: RuntimeSettingsState,
    options?: { readonly translationConfigurationChanged?: boolean },
  ): void;
  updateStatus(status: RuntimeStatus): void;
  dispose(): void;
}

const EMPTY_METADATA: PagePlaybackMetadata = {
  title: '等待 Netflix 影片',
  playback: 'unavailable',
  audioTrack: '等待 Netflix 音轨信息',
  subtitleTrack: '等待 Netflix 字幕轨信息',
};
const EMPTY_CATALOG: PageCatalogSummary = {
  authority: 'unknown',
  englishTrack: '等待 Netflix 字幕目录',
  chineseTrack: '等待 Netflix 字幕目录',
  officialChinese: false,
};

export function createPageControlCoordinator(
  options: PageControlCoordinatorOptions,
): PageControlCoordinator {
  const schedule = options.schedule ?? ((callback) => window.setTimeout(callback, 140));
  const cancel = options.cancel ?? ((handle) => window.clearTimeout(handle));
  let settings = cloneRuntimeSettings(options.initialSettings);
  let authoritativeSettings = cloneRuntimeSettings(options.initialSettings);
  let paused = false;
  let pipeline = '等待字幕数据';
  let saveState: PageControlSurfaceModel['saveState'] = 'idle';
  let status: RuntimeStatus = { mode: 'discovering' };
  let metadata = EMPTY_METADATA;
  let catalog = EMPTY_CATALOG;
  let pendingSave: number | undefined;
  let saveRevision = 0;
  let enabledLocallyDirty = false;
  let appearanceLocallyDirty = false;
  let providerLocallyDirty = false;
  let enabledPendingDispatch = false;
  let appearancePendingDispatch = false;
  let providerPendingDispatch = false;
  let disposed = false;

  const model = (): PageControlSurfaceModel => ({
    settings: cloneRuntimeSettings(settings),
    paused,
    pipeline,
    saveState,
    status,
    metadata: { ...metadata },
    catalog: { ...catalog },
  });
  const render = (): void => {
    if (!disposed) options.render(model());
  };
  const apply = (
    applyOptions?: { readonly translationConfigurationChanged?: boolean },
  ): void => {
    if (disposed) return;
    options.applySettings({
      ...cloneRuntimeSettings(settings),
      enabled: settings.enabled && !paused,
    }, applyOptions);
  };
  const rollbackFailedMutation = (
    mutation: PageControlSettingsMutation,
  ): void => {
    const authoritative = cloneRuntimeSettings(authoritativeSettings);
    settings = {
      ...authoritative,
      enabled: mutation.updateEnabled ? authoritative.enabled : settings.enabled,
      provider: mutation.updateProvider
        ? authoritative.provider
        : settings.provider,
      appearance: mutation.updateAppearance
        ? authoritative.appearance
        : cloneAppearance(settings.appearance),
    };
    if (!settings.enabled) paused = false;
    apply();
  };
  const persist = (): void => {
    if (disposed) return;
    pendingSave = undefined;
    const revision = ++saveRevision;
    const mutation: PageControlSettingsMutation = {
      enabled: settings.enabled,
      appearance: cloneAppearance(settings.appearance),
      provider: settings.provider,
      updateEnabled: enabledLocallyDirty,
      updateAppearance: appearanceLocallyDirty,
      updateProvider: providerLocallyDirty,
    };
    enabledPendingDispatch = false;
    appearancePendingDispatch = false;
    providerPendingDispatch = false;
    void options.persistSettings(mutation).then(
      (result) => {
        if (disposed || revision !== saveRevision) return;
        if (!result.ok) {
          enabledLocallyDirty = false;
          appearanceLocallyDirty = false;
          providerLocallyDirty = false;
          rollbackFailedMutation(mutation);
          saveState = 'error';
          render();
          return;
        }
        enabledLocallyDirty = false;
        appearanceLocallyDirty = false;
        providerLocallyDirty = false;
        saveState = 'saved';
        render();
      },
      () => {
        if (disposed || revision !== saveRevision) return;
        enabledLocallyDirty = false;
        appearanceLocallyDirty = false;
        providerLocallyDirty = false;
        rollbackFailedMutation(mutation);
        saveState = 'error';
        render();
      },
    );
  };
  const schedulePersist = (): void => {
    if (pendingSave !== undefined) cancel(pendingSave);
    pendingSave = schedule(persist);
  };

  render();
  return {
    setAppearance(appearance) {
      if (disposed) return;
      saveRevision += 1;
      settings = { ...settings, appearance: cloneAppearance(appearance) };
      appearanceLocallyDirty = true;
      appearancePendingDispatch = true;
      saveState = 'saving';
      apply();
      render();
      schedulePersist();
    },
    setEnabled(enabled) {
      if (disposed || settings.enabled === enabled) return;
      saveRevision += 1;
      settings = { ...settings, enabled };
      enabledLocallyDirty = true;
      enabledPendingDispatch = true;
      if (!enabled) paused = false;
      saveState = 'saving';
      apply();
      render();
      if (pendingSave !== undefined) {
        cancel(pendingSave);
        pendingSave = undefined;
      }
      persist();
    },
    setPaused(nextPaused) {
      if (disposed || paused === nextPaused || !settings.enabled) return;
      paused = nextPaused;
      apply();
      render();
    },
    setProvider(provider) {
      if (disposed || settings.provider === provider) return;
      saveRevision += 1;
      settings = { ...settings, provider };
      providerLocallyDirty = true;
      providerPendingDispatch = true;
      saveState = 'saving';
      apply({ translationConfigurationChanged: true });
      render();
      if (pendingSave !== undefined) {
        cancel(pendingSave);
        pendingSave = undefined;
      }
      persist();
    },
    updatePipeline(nextPipeline) {
      if (disposed || pipeline === nextPipeline) return;
      pipeline = nextPipeline;
      render();
    },
    updateCatalog(nextCatalog) {
      if (disposed) return;
      catalog = { ...nextCatalog };
      render();
    },
    updateMetadata(nextMetadata) {
      if (disposed) return;
      metadata = { ...nextMetadata };
      render();
    },
    updateSettings(nextSettings, updateOptions) {
      if (disposed) return;
      authoritativeSettings = cloneRuntimeSettings(nextSettings);
      settings = saveState === 'saving'
        ? {
            ...settings,
            enabled: enabledPendingDispatch ? settings.enabled : nextSettings.enabled,
            provider: providerPendingDispatch
              ? settings.provider
              : nextSettings.provider,
            deepseekKeyReady: nextSettings.deepseekKeyReady,
            appearance: appearancePendingDispatch
              ? settings.appearance
              : cloneAppearance(nextSettings.appearance),
          }
        : cloneRuntimeSettings(nextSettings);
      if (!settings.enabled) paused = false;
      apply(updateOptions);
      render();
    },
    updateStatus(nextStatus) {
      if (disposed) return;
      status = nextStatus;
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      saveRevision += 1;
      if (pendingSave !== undefined) cancel(pendingSave);
      pendingSave = undefined;
    },
  };
}

function cloneRuntimeSettings(settings: RuntimeSettingsState): RuntimeSettingsState {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    deepseekKeyReady: settings.deepseekKeyReady,
    appearance: cloneAppearance(settings.appearance),
  };
}

function cloneAppearance(
  appearance: SubtitleAppearanceSettings,
): SubtitleAppearanceSettings {
  return {
    english: { ...appearance.english },
    chinese: { ...appearance.chinese },
    order: appearance.order,
    lineSpacingPx: appearance.lineSpacingPx,
    maxLineWidthPercent: appearance.maxLineWidthPercent,
    verticalOffsetPercent: appearance.verticalOffsetPercent,
    backgroundOpacity: appearance.backgroundOpacity,
    shadow: appearance.shadow,
  };
}
