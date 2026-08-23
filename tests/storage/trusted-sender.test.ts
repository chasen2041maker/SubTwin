import { describe, expect, it } from 'vitest';

import {
  isTrustedSettingsSender,
  trustedNetflixContentTabId,
} from '../../src/storage/trusted-sender';

const runtimeId = 'subtwin-extension-id';
const extensionBaseUrl = 'chrome-extension://subtwin-extension-id/';

describe('settings action sender authorization', () => {
  it('accepts the exact matching extension page with or without a tab sender', () => {
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
        tab: { id: 7 },
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

describe('Netflix content sender authorization', () => {
  it('returns the tab id for the matching extension on the exact Netflix HTTPS origin', () => {
    expect(trustedNetflixContentTabId({
      id: runtimeId,
      tab: { id: 42 },
      url: 'https://www.netflix.com/watch/81234567?track=1#player',
    }, runtimeId)).toBe(42);
    expect(trustedNetflixContentTabId({
      id: runtimeId,
      tab: { id: 0 },
      url: 'https://www.netflix.com:443/',
    }, runtimeId)).toBe(0);
  });

  it.each([
    ['another extension', { id: 'other-extension', tab: { id: 1 }, url: 'https://www.netflix.com/' }],
    ['missing tab', { id: runtimeId, url: 'https://www.netflix.com/' }],
    ['missing tab id', { id: runtimeId, tab: {}, url: 'https://www.netflix.com/' }],
    ['negative tab id', { id: runtimeId, tab: { id: -1 }, url: 'https://www.netflix.com/' }],
    ['fractional tab id', { id: runtimeId, tab: { id: 1.5 }, url: 'https://www.netflix.com/' }],
    ['HTTP', { id: runtimeId, tab: { id: 1 }, url: 'http://www.netflix.com/' }],
    ['bare domain', { id: runtimeId, tab: { id: 1 }, url: 'https://netflix.com/' }],
    ['subdomain', { id: runtimeId, tab: { id: 1 }, url: 'https://movies.www.netflix.com/' }],
    ['lookalike', { id: runtimeId, tab: { id: 1 }, url: 'https://www.netflix.com.evil.test/' }],
    ['credentials', { id: runtimeId, tab: { id: 1 }, url: 'https://user:pass@www.netflix.com/' }],
    ['non-default port', { id: runtimeId, tab: { id: 1 }, url: 'https://www.netflix.com:444/' }],
    ['malformed URL', { id: runtimeId, tab: { id: 1 }, url: 'not a URL' }],
  ] as const)('rejects %s', (_name, sender) => {
    expect(trustedNetflixContentTabId(sender, runtimeId)).toBeNull();
  });
});
