import { describe, expect, it, vi } from 'vitest';

import {
  createPageControlCoordinator,
  type PageControlSettingsMutation,
  type PageControlPersistenceResult,
} from '../../src/app/page-control-coordinator';
import type { PageControlSurfaceModel } from '../../src/renderer/PageControlSurface';
import { DEFAULT_SETTINGS, type RuntimeSettingsState } from '../../src/storage/schema';

const settings: RuntimeSettingsState = {
  enabled: true,
  provider: 'google-free',
  deepseekKeyReady: false,
  appearance: DEFAULT_SETTINGS.appearance,
};

function setup() {
  const rendered: PageControlSurfaceModel[] = [];
  const applied: RuntimeSettingsState[] = [];
  const applyOptions: Array<{
    readonly translationConfigurationChanged?: boolean;
  } | undefined> = [];
  const saves: Array<PageControlSettingsMutation & {
    readonly resolve: (result: PageControlPersistenceResult) => void;
  }> = [];
  let scheduled: (() => void) | undefined;
  const coordinator = createPageControlCoordinator({
    initialSettings: settings,
    applySettings: (next, options) => {
      applied.push(next);
      applyOptions.push(options);
    },
    persistSettings: (mutation) => new Promise((resolve) => {
      saves.push({ ...mutation, resolve });
    }),
    render: (model) => rendered.push(model),
    schedule: (callback) => {
      scheduled = callback;
      return 1;
    },
    cancel: () => { scheduled = undefined; },
  });
  return {
    applied,
    applyOptions,
    coordinator,
    flush: () => { const callback = scheduled; scheduled = undefined; callback?.(); },
    rendered,
    saves,
  };
}

describe('page control coordinator', () => {
  it('pauses only the current tab and restores the global enabled state on resume', () => {
    const state = setup();

    state.coordinator.setPaused(true);
    expect(state.applied.at(-1)).toMatchObject({ enabled: false });
    expect(state.rendered.at(-1)).toMatchObject({
      paused: true,
      settings: { enabled: true },
    });
    expect(state.saves).toHaveLength(0);

    state.coordinator.setPaused(false);
    expect(state.applied.at(-1)).toMatchObject({ enabled: true });
    expect(state.saves).toHaveLength(0);
  });

  it('applies appearance immediately, debounces persistence and publishes save completion', async () => {
    const state = setup();
    const first = {
      ...settings.appearance,
      lineSpacingPx: 14,
    };
    const latest = {
      ...first,
      english: { ...first.english, fontFamily: 'serif' as const },
    };

    state.coordinator.setAppearance(first);
    state.coordinator.setAppearance(latest);
    expect(state.applied.at(-1)?.appearance).toEqual(latest);
    expect(state.rendered.at(-1)?.saveState).toBe('saving');
    expect(state.saves).toHaveLength(0);

    state.flush();
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({
      enabled: true,
      appearance: latest,
      updateEnabled: false,
      updateAppearance: true,
    });
    state.saves[0]!.resolve({ ok: true, settings: { ...settings, appearance: latest } });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.rendered.at(-1)?.saveState).toBe('saved');
  });

  it('persists global enable immediately and reports a typed save failure', async () => {
    const state = setup();

    state.coordinator.setEnabled(false);
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({
      enabled: false,
      appearance: settings.appearance,
      updateEnabled: true,
      updateAppearance: false,
    });
    expect(state.applied.at(-1)).toMatchObject({ enabled: false });
    state.saves[0]!.resolve({ ok: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.rendered.at(-1)?.saveState).toBe('error');
    expect(state.rendered.at(-1)?.settings.enabled).toBe(true);
    expect(state.applied.at(-1)?.enabled).toBe(true);
  });

  it('switches subtitle source immediately and persists the provider choice', async () => {
    const state = setup();

    state.coordinator.setProvider('deepseek');

    expect(state.applied.at(-1)).toMatchObject({ provider: 'deepseek' });
    expect(state.applyOptions.at(-1)).toEqual({
      translationConfigurationChanged: true,
    });
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({
      provider: 'deepseek',
      updateProvider: true,
      updateEnabled: false,
      updateAppearance: false,
    });
  });

  it('rolls a failed appearance save back to the latest authoritative push', async () => {
    const state = setup();
    const authoritativeAppearance = {
      ...settings.appearance,
      lineSpacingPx: 11,
    };
    const localAppearance = {
      ...settings.appearance,
      lineSpacingPx: 19,
    };

    state.coordinator.setAppearance(localAppearance);
    state.coordinator.updateSettings({
      ...settings,
      enabled: false,
      appearance: authoritativeAppearance,
    });
    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saving',
      settings: { enabled: false, appearance: localAppearance },
    });

    state.flush();
    state.saves[0]!.resolve({ ok: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'error',
      settings: { enabled: false, appearance: authoritativeAppearance },
    });
    expect(state.applied.at(-1)).toMatchObject({
      enabled: false,
      appearance: authoritativeAppearance,
    });
  });

  it('does not let an older failed request roll back a newer local edit', async () => {
    const state = setup();
    const first = {
      ...settings.appearance,
      lineSpacingPx: 11,
    };
    const latest = {
      ...settings.appearance,
      lineSpacingPx: 19,
    };

    state.coordinator.setAppearance(first);
    state.flush();
    state.coordinator.setAppearance(latest);
    state.saves[0]!.resolve({ ok: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saving',
      settings: { appearance: latest },
    });
    state.flush();
    expect(state.saves[1]).toMatchObject({
      appearance: latest,
      updateAppearance: true,
    });
  });

  it('preserves a newer local appearance across an older broadcast and save response', async () => {
    const state = setup();
    const olderAppearance = {
      ...settings.appearance,
      lineSpacingPx: 11,
    };
    const newerAppearance = {
      ...olderAppearance,
      lineSpacingPx: 19,
    };

    state.coordinator.setAppearance(olderAppearance);
    state.flush();
    expect(state.saves).toHaveLength(1);

    state.coordinator.setAppearance(newerAppearance);
    state.coordinator.updateSettings({
      ...settings,
      provider: 'deepseek',
      deepseekKeyReady: true,
      appearance: olderAppearance,
    }, { translationConfigurationChanged: true });

    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saving',
      settings: {
        enabled: true,
        provider: 'deepseek',
        deepseekKeyReady: true,
        appearance: newerAppearance,
      },
    });
    expect(state.applyOptions.at(-1)).toEqual({
      translationConfigurationChanged: true,
    });

    state.saves[0]!.resolve({
      ok: true,
      settings: { ...settings, appearance: olderAppearance },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saving',
      settings: {
        provider: 'deepseek',
        deepseekKeyReady: true,
        appearance: newerAppearance,
      },
    });

    state.flush();
    expect(state.saves).toHaveLength(2);
    expect(state.saves[1]).toMatchObject({
      enabled: true,
      appearance: newerAppearance,
      updateEnabled: false,
      updateAppearance: true,
    });
    state.saves[1]!.resolve({
      ok: true,
      settings: {
        ...settings,
        appearance: newerAppearance,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saved',
      settings: {
        provider: 'deepseek',
        deepseekKeyReady: true,
        appearance: newerAppearance,
      },
    });
  });

  it('rebases a delayed appearance save onto an authoritative global disable', () => {
    const state = setup();
    const localAppearance = {
      ...settings.appearance,
      lineSpacingPx: 19,
    };

    state.coordinator.setAppearance(localAppearance);
    state.coordinator.updateSettings({
      ...settings,
      enabled: false,
      provider: 'deepseek',
      deepseekKeyReady: true,
    }, { translationConfigurationChanged: true });

    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saving',
      settings: {
        enabled: false,
        provider: 'deepseek',
        deepseekKeyReady: true,
        appearance: localAppearance,
      },
    });
    expect(state.applied.at(-1)).toMatchObject({
      enabled: false,
      provider: 'deepseek',
      deepseekKeyReady: true,
      appearance: localAppearance,
    });
    expect(state.applyOptions.at(-1)).toEqual({
      translationConfigurationChanged: true,
    });

    state.flush();
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({
      enabled: false,
      appearance: localAppearance,
      updateEnabled: false,
      updateAppearance: true,
    });
  });

  it('invalidates an in-flight save as soon as enabled changes locally', async () => {
    const state = setup();
    const appearance = {
      ...settings.appearance,
      verticalOffsetPercent: 17,
    };

    state.coordinator.setAppearance(appearance);
    state.flush();
    expect(state.saves).toHaveLength(1);

    state.coordinator.setEnabled(false);
    expect(state.saves).toHaveLength(2);
    expect(state.saves[1]).toMatchObject({
      enabled: false,
      appearance,
      updateEnabled: true,
      updateAppearance: true,
    });

    state.coordinator.updateSettings({
      ...settings,
      provider: 'deepseek',
      deepseekKeyReady: true,
      appearance,
    }, { translationConfigurationChanged: true });
    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saving',
      settings: {
        enabled: true,
        provider: 'deepseek',
        deepseekKeyReady: true,
        appearance,
      },
    });
    expect(state.applyOptions.at(-1)).toEqual({
      translationConfigurationChanged: true,
    });

    state.saves[0]!.resolve({
      ok: true,
      settings: { ...settings, appearance },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saving',
      settings: { enabled: true, appearance },
    });

    state.coordinator.updateSettings({
      ...settings,
      enabled: false,
      provider: 'deepseek',
      deepseekKeyReady: true,
      appearance,
    }, { translationConfigurationChanged: true });

    state.saves[1]!.resolve({
      ok: true,
      settings: {
        ...settings,
        enabled: false,
        provider: 'deepseek',
        deepseekKeyReady: true,
        appearance,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saved',
      settings: { enabled: false, appearance },
    });
  });

  it('accepts a newer authoritative enable push while the page request is in flight', async () => {
    const state = setup();

    state.coordinator.setEnabled(false);
    expect(state.saves).toHaveLength(1);

    state.coordinator.updateSettings({
      ...settings,
      enabled: true,
      provider: 'deepseek',
      deepseekKeyReady: true,
    }, { translationConfigurationChanged: true });
    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saving',
      settings: {
        enabled: true,
        provider: 'deepseek',
        deepseekKeyReady: true,
      },
    });

    state.saves[0]!.resolve({
      ok: true,
      settings: { ...settings, enabled: false },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saved',
      settings: {
        enabled: true,
        provider: 'deepseek',
        deepseekKeyReady: true,
      },
    });
  });

  it('keeps a popup disable when an older appearance acknowledgement arrives last', async () => {
    const state = setup();
    const appearance = {
      ...settings.appearance,
      lineSpacingPx: 19,
    };

    state.coordinator.setAppearance(appearance);
    state.flush();
    expect(state.saves).toHaveLength(1);

    state.coordinator.updateSettings({
      ...settings,
      enabled: false,
      appearance,
    });
    state.saves[0]!.resolve({
      ok: true,
      settings: { ...settings, enabled: true, appearance },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(state.rendered.at(-1)).toMatchObject({
      saveState: 'saved',
      settings: { enabled: false, appearance },
    });
  });

  it('keeps a current-tab pause active across authoritative background pushes', () => {
    const state = setup();
    state.coordinator.setPaused(true);
    state.coordinator.updateSettings({
      ...settings,
      provider: 'deepseek',
      deepseekKeyReady: true,
    });

    expect(state.applied.at(-1)).toMatchObject({ enabled: false, provider: 'deepseek' });
    expect(state.rendered.at(-1)).toMatchObject({
      paused: true,
      settings: { enabled: true, provider: 'deepseek' },
    });
  });

  it('updates status, metadata and catalog without changing runtime settings', () => {
    const state = setup();
    const appliedBefore = state.applied.length;

    state.coordinator.updateStatus({ mode: 'error', code: 'rate_limited' });
    state.coordinator.updatePipeline('字幕解析失败：invalid_ttml');
    state.coordinator.updateMetadata({
      title: '王冠',
      playback: 'paused',
      audioTrack: '英语',
      subtitleTrack: '英语 (CC)',
    });
    state.coordinator.updateCatalog({
      authority: 'authoritative',
      englishTrack: 'en-US · closed-caption',
      chineseTrack: '未发现简体中文字幕',
      officialChinese: false,
    });

    expect(state.applied).toHaveLength(appliedBefore);
    expect(state.rendered.at(-1)).toMatchObject({
      status: { mode: 'error', code: 'rate_limited' },
      pipeline: '字幕解析失败：invalid_ttml',
      metadata: { title: '王冠', playback: 'paused' },
      catalog: { authority: 'authoritative', officialChinese: false },
    });
  });
});
