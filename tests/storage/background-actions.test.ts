import { describe, expect, it, vi } from 'vitest';

import { createMessage } from '../../src/shared/messages';
import { createSettingsActionHandler } from '../../src/storage/background-actions';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type SubTwinSettings,
} from '../../src/storage/schema';

function deepseekResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          translations: [{ id: 'connection-test', text: '连接测试。' }],
        }),
      },
    }],
  }), { status: 200 });
}

const testMessage = createMessage({
  id: 'settings-test-1',
  source: 'options',
  type: 'settings/deepseek-test',
  payload: {},
});

describe('background settings actions', () => {
  it('tests only the stored DeepSeek credentials and returns no secrets', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(deepseekResponse());
    const handler = createSettingsActionHandler({
      fetch,
      settingsStore: createStore({
        ...DEFAULT_SETTINGS,
        deepseek: { apiKey: 'background-only-key', model: 'deepseek-v4-flash' },
      }).store,
      cache: { clearAll: vi.fn(), clearEpisode: vi.fn() },
      readCurrentEpisodeId: vi.fn(),
    });

    const result = await handler(testMessage);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer background-only-key',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        source: 'background',
        type: 'settings/deepseek-test-result',
        payload: { status: 'success', errorCode: null, retryable: false },
      },
    });
    expect(JSON.stringify(result)).not.toContain('background-only-key');
    expect(JSON.stringify(result)).not.toContain('deepseek-v4-flash');
  });

  it('makes zero network calls when the stored key or model is invalid', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const handler = createSettingsActionHandler({
      fetch,
      settingsStore: {
        load: vi.fn().mockResolvedValue({
          ...DEFAULT_SETTINGS,
          deepseek: { apiKey: '', model: 'retired-model' },
        }),
        save: vi.fn(),
      } as never,
      cache: { clearAll: vi.fn(), clearEpisode: vi.fn() },
      readCurrentEpisodeId: vi.fn(),
    });

    await expect(handler(testMessage)).resolves.toMatchObject({
      ok: true,
      value: {
        payload: { status: 'error', errorCode: 'invalid_configuration' },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears all cache only after an exact options message', async () => {
    const clearAll = vi.fn().mockResolvedValue(undefined);
    const clearEpisode = vi.fn();
    const handler = createSettingsActionHandler({
      fetch: vi.fn(),
      settingsStore: createStore().store,
      cache: { clearAll, clearEpisode },
      readCurrentEpisodeId: vi.fn(),
    });
    const message = createMessage({
      id: 'settings-cache-all',
      source: 'options',
      type: 'settings/cache-clear',
      payload: { scope: 'all' },
    });

    await expect(handler(message)).resolves.toMatchObject({
      ok: true,
      value: { payload: { scope: 'all', status: 'success', errorCode: null } },
    });
    expect(clearAll).toHaveBeenCalledOnce();
    expect(clearEpisode).not.toHaveBeenCalled();
  });

  it('clears only the background-known current episode and never trusts an options ID', async () => {
    const clearEpisode = vi.fn().mockResolvedValue(undefined);
    const handler = createSettingsActionHandler({
      fetch: vi.fn(),
      settingsStore: createStore().store,
      cache: { clearAll: vi.fn(), clearEpisode },
      readCurrentEpisodeId: vi.fn().mockResolvedValue('episode_hash_1'),
    });
    const message = createMessage({
      id: 'settings-cache-episode',
      source: 'options',
      type: 'settings/cache-clear',
      payload: { scope: 'episode' },
    });

    await expect(handler(message)).resolves.toMatchObject({
      ok: true,
      value: { payload: { scope: 'episode', status: 'success' } },
    });
    expect(clearEpisode).toHaveBeenCalledExactlyOnceWith('episode_hash_1');
  });

  it('does not over-clear when no current episode is known', async () => {
    const clearAll = vi.fn();
    const clearEpisode = vi.fn();
    const handler = createSettingsActionHandler({
      fetch: vi.fn(),
      settingsStore: createStore().store,
      cache: { clearAll, clearEpisode },
      readCurrentEpisodeId: vi.fn().mockResolvedValue(undefined),
    });
    const message = createMessage({
      id: 'settings-cache-episode',
      source: 'options',
      type: 'settings/cache-clear',
      payload: { scope: 'episode' },
    });

    await expect(handler(message)).resolves.toMatchObject({
      ok: true,
      value: {
        payload: {
          scope: 'episode',
          status: 'error',
          errorCode: 'current_episode_unavailable',
        },
      },
    });
    expect(clearEpisode).not.toHaveBeenCalled();
    expect(clearAll).not.toHaveBeenCalled();
  });

  it('keeps a popup enable mutation from overwriting newer options credentials', async () => {
    const state = createStore();
    const handler = createSettingsActionHandler({
      fetch: vi.fn(),
      settingsStore: state.store,
      cache: { clearAll: vi.fn(), clearEpisode: vi.fn() },
      readCurrentEpisodeId: vi.fn(),
    });
    const optionsUpdate = createMessage({
      id: 'settings-options-update',
      source: 'options',
      type: 'settings/options-update',
      payload: {
        patch: {
          deepseek: { apiKey: 'new-private-key', model: 'deepseek-v4-pro' },
          provider: 'deepseek',
        },
      },
    });
    const enabledSet = createMessage({
      id: 'settings-enabled-set',
      source: 'popup',
      type: 'settings/enabled-set',
      payload: { enabled: false },
    });

    await Promise.all([handler(optionsUpdate), handler(enabledSet)]);

    expect(state.current()).toMatchObject({
      enabled: false,
      provider: 'deepseek',
      deepseek: { apiKey: 'new-private-key', model: 'deepseek-v4-pro' },
    });
  });

  it('returns only public settings to popup callers', async () => {
    const state = createStore({
      ...DEFAULT_SETTINGS,
      provider: 'deepseek',
      deepseek: { apiKey: 'background-secret', model: 'deepseek-v4-flash' },
    });
    const handler = createSettingsActionHandler({
      fetch: vi.fn(),
      settingsStore: state.store,
      cache: { clearAll: vi.fn(), clearEpisode: vi.fn() },
      readCurrentEpisodeId: vi.fn(),
    });
    const response = await handler(createMessage({
      id: 'settings-public-get',
      source: 'popup',
      type: 'settings/public-get',
      payload: {},
    }));

    expect(response).toMatchObject({
      ok: true,
      value: {
        type: 'settings/public-get-result',
        payload: { enabled: true, provider: 'deepseek' },
      },
    });
    expect(JSON.stringify(response)).not.toContain('background-secret');
  });

  it('persists an options-page enabled patch without replacing other settings', async () => {
    const state = createStore({
      ...DEFAULT_SETTINGS,
      provider: 'deepseek',
      deepseek: { apiKey: 'keep-this-key', model: 'deepseek-v4-pro' },
    });
    const handler = createSettingsActionHandler({
      fetch: vi.fn(),
      settingsStore: state.store,
      cache: { clearAll: vi.fn(), clearEpisode: vi.fn() },
      readCurrentEpisodeId: vi.fn(),
    });

    await handler(createMessage({
      id: 'options-enabled-update',
      source: 'options',
      type: 'settings/options-update',
      payload: {
        patch: { enabled: false },
      },
    }));

    expect(state.current()).toMatchObject({
      enabled: false,
      provider: 'deepseek',
      deepseek: { apiKey: 'keep-this-key', model: 'deepseek-v4-pro' },
    });
  });

  it('persists a Netflix page appearance patch without exposing or replacing private settings', async () => {
    const state = createStore({
      ...DEFAULT_SETTINGS,
      provider: 'deepseek',
      deepseek: { apiKey: 'keep-page-secret', model: 'deepseek-v4-pro' },
    });
    const handler = createSettingsActionHandler({
      fetch: vi.fn(),
      settingsStore: state.store,
      cache: { clearAll: vi.fn(), clearEpisode: vi.fn() },
      readCurrentEpisodeId: vi.fn(),
    });
    const appearance = {
      ...DEFAULT_SETTINGS.appearance,
      order: 'chinese-first' as const,
      chinese: {
        ...DEFAULT_SETTINGS.appearance.chinese,
        fontFamily: 'rounded' as const,
        color: '#33AAFF',
      },
    };

    const result = await handler(createMessage({
      id: 'settings-page-update',
      source: 'content',
      type: 'settings/page-update',
      payload: {
        enabled: false,
        provider: 'google-free',
        appearance,
        updateEnabled: true,
        updateAppearance: true,
        updateProvider: true,
      },
    }));

    expect(state.current()).toMatchObject({
      enabled: false,
      provider: 'google-free',
      deepseek: { apiKey: 'keep-page-secret', model: 'deepseek-v4-pro' },
      appearance,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        source: 'background',
        type: 'settings/page-update-result',
        payload: {
          status: 'success',
          errorCode: null,
          enabled: false,
          provider: 'google-free',
          appearance,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('keep-page-secret');
    expect(JSON.stringify(result)).not.toContain('deepseek-v4-pro');
  });

  it('applies only the page fields explicitly marked dirty after other settings mutations', async () => {
    const state = createStore();
    const handler = createSettingsActionHandler({
      fetch: vi.fn(),
      settingsStore: state.store,
      cache: { clearAll: vi.fn(), clearEpisode: vi.fn() },
      readCurrentEpisodeId: vi.fn(),
    });
    const appearance = {
      ...DEFAULT_SETTINGS.appearance,
      lineSpacingPx: 19,
    };
    const optionsUpdate = createMessage({
      id: 'settings-options-before-page',
      source: 'options',
      type: 'settings/options-update',
      payload: {
        patch: {
          provider: 'deepseek',
          deepseek: { apiKey: 'new-private-key', model: 'deepseek-v4-pro' },
        },
      },
    });
    const enabledSet = createMessage({
      id: 'settings-disabled-before-page',
      source: 'popup',
      type: 'settings/enabled-set',
      payload: { enabled: false },
    });
    const pageUpdate = createMessage({
      id: 'settings-stale-page-appearance',
      source: 'content',
      type: 'settings/page-update',
      payload: {
        enabled: true,
        provider: 'unset',
        appearance,
        updateEnabled: false,
        updateAppearance: true,
        updateProvider: false,
      },
    });

    await Promise.all([
      handler(optionsUpdate),
      handler(enabledSet),
      handler(pageUpdate),
    ]);

    expect(state.current()).toMatchObject({
      enabled: false,
      provider: 'deepseek',
      deepseek: { apiKey: 'new-private-key', model: 'deepseek-v4-pro' },
      appearance,
    });
  });

  it.each(['page-first', 'options-first'] as const)(
    'preserves page appearance and options credentials in %s commit order',
    async (order) => {
      const state = createStore();
      const handler = createSettingsActionHandler({
        fetch: vi.fn(),
        settingsStore: state.store,
        cache: { clearAll: vi.fn(), clearEpisode: vi.fn() },
        readCurrentEpisodeId: vi.fn(),
      });
      const appearance = {
        ...DEFAULT_SETTINGS.appearance,
        verticalOffsetPercent: 17,
      };
      const disable = createMessage({
        id: `disable-${order}`,
        source: 'popup',
        type: 'settings/enabled-set',
        payload: { enabled: false },
      });
      const pageUpdate = createMessage({
        id: `page-${order}`,
        source: 'content',
        type: 'settings/page-update',
        payload: {
          enabled: true,
          provider: 'unset',
          appearance,
          updateEnabled: false,
          updateAppearance: true,
          updateProvider: false,
        },
      });
      const optionsUpdate = createMessage({
        id: `options-${order}`,
        source: 'options',
        type: 'settings/options-update',
        payload: {
          patch: {
            provider: 'deepseek',
            deepseek: { apiKey: 'kept-private-key', model: 'deepseek-v4-pro' },
          },
        },
      });

      await handler(disable);
      for (const mutation of order === 'page-first'
        ? [pageUpdate, optionsUpdate]
        : [optionsUpdate, pageUpdate]) {
        await handler(mutation);
      }

      expect(state.current()).toMatchObject({
        enabled: false,
        provider: 'deepseek',
        deepseek: { apiKey: 'kept-private-key', model: 'deepseek-v4-pro' },
        appearance,
      });
    },
  );
});

function createStore(initial: SubTwinSettings = DEFAULT_SETTINGS) {
  let settings = normalizeSettings(initial);
  const store = {
    load: vi.fn(async () => normalizeSettings(settings)),
    save: vi.fn(async (candidate: unknown) => {
      settings = normalizeSettings(candidate);
      return normalizeSettings(settings);
    }),
  };
  return { store, current: () => settings };
}
