import { describe, expect, it } from 'vitest';

import { isTrustedSettingsSender } from '../../src/storage/trusted-sender';

const runtimeId = 'subtwin-extension-id';
const extensionBaseUrl = 'chrome-extension://subtwin-extension-id/';

describe('settings action sender authorization', () => {
  it('accepts only the matching extension page without a tab sender', () => {
    expect(isTrustedSettingsSender(
      {
        id: runtimeId,
        url: `${extensionBaseUrl}options.html`,
      },
      'options',
      runtimeId,
      extensionBaseUrl,
    )).toBe(true);

    expect(isTrustedSettingsSender(
      {
        id: runtimeId,
        url: `${extensionBaseUrl}popup.html`,
      },
      'popup',
      runtimeId,
      extensionBaseUrl,
    )).toBe(true);
  });

  it('rejects a content sender that forges source=options', () => {
    expect(isTrustedSettingsSender(
      {
        id: runtimeId,
        tab: {},
        url: 'https://www.netflix.com/watch/123',
      },
      'options',
      runtimeId,
      extensionBaseUrl,
    )).toBe(false);
  });

  it('rejects other extensions, the wrong page, and URL lookalikes', () => {
    expect(isTrustedSettingsSender(
      { id: 'other-extension', url: `${extensionBaseUrl}options.html` },
      'options',
      runtimeId,
      extensionBaseUrl,
    )).toBe(false);
    expect(isTrustedSettingsSender(
      { id: runtimeId, url: `${extensionBaseUrl}popup.html` },
      'options',
      runtimeId,
      extensionBaseUrl,
    )).toBe(false);
    expect(isTrustedSettingsSender(
      { id: runtimeId, url: `${extensionBaseUrl}options.html.evil` },
      'options',
      runtimeId,
      extensionBaseUrl,
    )).toBe(false);
  });
});
