import { describe, expect, it } from 'vitest';

import {
  parsePageSettingsUpdateResponse,
  parseRuntimeSettingsPush,
  parseRuntimeSettingsResponse,
} from '../../src/app/runtime-settings-client';
import { createMessage } from '../../src/shared/messages';
import { ok } from '../../src/shared/result';
import { DEFAULT_SETTINGS } from '../../src/storage/schema';

const payload = {
  enabled: true,
  provider: 'deepseek' as const,
  deepseekKeyReady: true,
  appearance: DEFAULT_SETTINGS.appearance,
};

describe('runtime settings content client', () => {
  it('accepts only the exact correlated outer Result response', () => {
    const envelope = createMessage({
      id: 'request-1:background',
      source: 'background',
      type: 'runtime/settings-state',
      payload,
    });
    const response = ok(envelope);

    expect(parseRuntimeSettingsResponse(response, 'request-1')).toEqual(payload);
    expect(parseRuntimeSettingsResponse(response, 'request-2')).toBeNull();
    expect(parseRuntimeSettingsResponse(envelope, 'request-1')).toBeNull();
    expect(parseRuntimeSettingsResponse({ ...response, extra: true }, 'request-1')).toBeNull();
  });

  it('accepts only background push IDs and preserves the configuration-change bit', () => {
    const push = (kind: 'config' | 'display') => createMessage({
      id: `runtime-settings-push-${kind}-123-4`,
      source: 'background',
      type: 'runtime/settings-state',
      payload,
    });

    expect(parseRuntimeSettingsPush(push('config'))).toEqual({
      settings: payload,
      translationConfigurationChanged: true,
    });
    expect(parseRuntimeSettingsPush(push('display'))).toEqual({
      settings: payload,
      translationConfigurationChanged: false,
    });
    expect(parseRuntimeSettingsPush(createMessage({
      ...push('config'),
      id: 'runtime-settings-push-config-invalid',
    }))).toBeNull();
    expect(parseRuntimeSettingsPush(createMessage({
      ...push('config'),
      source: 'content',
    }))).toBeNull();
  });

  it('accepts only the correlated page settings mutation result', () => {
    const appearance = {
      ...DEFAULT_SETTINGS.appearance,
      order: 'chinese-first' as const,
    };
    const envelope = createMessage({
      id: 'page-update-1:background',
      source: 'background',
      type: 'settings/page-update-result',
      payload: {
        status: 'success',
        errorCode: null,
        enabled: false,
        provider: 'google-free',
        appearance,
      },
    });
    const response = ok(envelope);

    expect(parsePageSettingsUpdateResponse(response, 'page-update-1')).toEqual({
      enabled: false,
      provider: 'google-free',
      appearance,
    });
    expect(parsePageSettingsUpdateResponse(response, 'other-request')).toBeNull();
    expect(parsePageSettingsUpdateResponse(ok(createMessage({
      ...envelope,
      payload: {
        ...envelope.payload,
        status: 'error',
        errorCode: 'settings_unavailable',
      },
    })), 'page-update-1')).toBeNull();
  });
});
