import { describe, expect, it, vi } from 'vitest';

import {
  NETFLIX_CONTROL_SOURCE,
  createIsolatedNetflixBridge,
  installMainWorldNetflixRuntime,
  parseNetflixControlEvent,
  type NetflixRuntimeWindow,
} from '../../src/netflix/runtime';
import type { NetflixCatalogDownloadResource } from '../../src/netflix/catalog-download';
import { err, ok } from '../../src/shared/result';

const NONCE = '0123456789abcdef0123456789abcdef';

class FakeXhr {
  open(): void {}
  send(): void {}
}

class FakeWindow implements NetflixRuntimeWindow {
  readonly location = {
    origin: 'https://www.netflix.com',
    pathname: '/watch/title-1',
  };
  readonly sent: Array<{ readonly data: unknown; readonly targetOrigin: string }> = [];
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  fetch = vi.fn(async () => {
    throw new Error('not used by this unit test');
  });

  XMLHttpRequest = FakeXhr as never;
  readonly JSON = { parse: JSON.parse };

  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(data: unknown, targetOrigin: string): void {
    this.sent.push({ data, targetOrigin });
  }

  emit(data: unknown, origin = this.location.origin, source: unknown = this): void {
    const event = { data, origin, source } as MessageEvent;
    for (const listener of [...this.listeners]) listener(event);
  }
}

describe('Netflix bridge control protocol', () => {
  it('accepts only exact same-window Netflix connect/disconnect messages', () => {
    const window = new FakeWindow();
    const control = {
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 4,
    } as const;

    expect(
      parseNetflixControlEvent(
        { data: control, origin: window.location.origin, source: window },
        window,
      ),
    ).toEqual({ ok: true, value: control });
    expect(
      parseNetflixControlEvent(
        { data: { ...control, rawUrl: 'token=secret' }, origin: window.location.origin, source: window },
        window,
      ).ok,
    ).toBe(false);
    expect(
      parseNetflixControlEvent(
        { data: control, origin: 'https://evil.example', source: window },
        window,
      ).ok,
    ).toBe(false);
    expect(
      parseNetflixControlEvent(
        { data: control, origin: window.location.origin, source: {} },
        window,
      ).ok,
    ).toBe(false);
  });
});

describe('isolated and MAIN-world Netflix runtimes', () => {
  it('connects with a nonce before accepting payloads and disconnects once', () => {
    const window = new FakeWindow();
    const received: unknown[] = [];
    const bridge = createIsolatedNetflixBridge({
      window,
      nonce: NONCE,
      generation: 2,
      onPayload: (payload) => received.push(payload),
    });

    bridge.start();
    bridge.start();
    expect(window.sent).toEqual([
      {
        targetOrigin: 'https://www.netflix.com',
        data: {
          protocol: 'subtwin.netflix.bridge',
          version: 1,
          source: NETFLIX_CONTROL_SOURCE,
          type: 'connect',
          nonce: NONCE,
          generation: 2,
        },
      },
    ]);

    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: 'subtwin-netflix-main-world',
      nonce: NONCE,
      generation: 1,
      payload: { type: 'diagnostic', code: 'candidate_rejected' },
    });
    expect(received).toEqual([]);

    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: 'subtwin-netflix-main-world',
      nonce: NONCE,
      generation: 2,
      payload: { type: 'diagnostic', code: 'candidate_rejected' },
    });
    expect(received).toEqual([
      { type: 'diagnostic', code: 'candidate_rejected' },
    ]);

    bridge.dispose();
    bridge.dispose();
    expect(window.sent.at(-1)?.data).toMatchObject({
      type: 'disconnect',
      nonce: NONCE,
      generation: 2,
    });
  });

  it('installs one probe owner, replaces it for a newer generation, and cleans up', () => {
    const window = new FakeWindow();
    const fetchDisposals: Array<ReturnType<typeof vi.fn>> = [];
    const xhrDisposals: Array<ReturnType<typeof vi.fn>> = [];
    const jsonDisposals: Array<ReturnType<typeof vi.fn>> = [];
    const fetchOptions: unknown[] = [];
    const runtime = installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => ok({
        type: 'catalog',
        titleId: 'title-1',
        authority: 'authoritative',
        tracks: [{ id: 'en-main', language: 'en-US', kind: 'subtitle' }],
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        fetchOptions.push(options);
        const dispose = vi.fn();
        fetchDisposals.push(dispose);
        return { dispose };
      },
      installXhr: (_target, _options) => {
        const dispose = vi.fn();
        xhrDisposals.push(dispose);
        return { dispose };
      },
      installJsonParse: (_target, _options) => {
        const dispose = vi.fn();
        jsonDisposals.push(dispose);
        return { dispose };
      },
    });

    expect(installMainWorldNetflixRuntime({ window })).toBe(runtime);
    const connect = (generation: number, nonce: string) =>
      window.emit({
        protocol: 'subtwin.netflix.bridge',
        version: 1,
        source: NETFLIX_CONTROL_SOURCE,
        type: 'connect',
        nonce,
        generation,
      });
    connect(1, NONCE);
    connect(1, NONCE);
    expect(fetchDisposals).toHaveLength(1);
    expect(jsonDisposals).toHaveLength(1);

    const firstOptions = fetchOptions[0] as {
      onTimedText(payload: unknown): void;
      onCatalog(payload: unknown): void;
      onDiagnostic(code: string): void;
    };
    const sentBeforeUnboundBody = window.sent.length;
    firstOptions.onTimedText({
      type: 'timed-text',
      resourceId: 'tt_0123456789abcdef',
      trackId: 'en-main',
      language: 'en',
      format: 'webvtt',
      body: 'WEBVTT\n\n',
    });
    expect(window.sent).toHaveLength(sentBeforeUnboundBody);
    firstOptions.onCatalog({
      type: 'catalog',
      titleId: 'title-1',
      authority: 'provisional',
      tracks: [{ id: 'en-main', language: 'en', kind: 'subtitle' }],
    });
    expect(window.sent.at(-1)?.targetOrigin).toBe('https://www.netflix.com');
    expect(window.sent.at(-1)?.data).toMatchObject({
      nonce: NONCE,
      generation: 1,
      payload: { type: 'catalog', authority: 'provisional' },
    });
    firstOptions.onDiagnostic('metadata_candidate_observed');
    expect(window.sent.at(-1)?.data).toMatchObject({
      nonce: NONCE,
      generation: 1,
      payload: {
        type: 'diagnostic',
        code: 'metadata_candidate_observed',
      },
    });

    const nextNonce = 'fedcba9876543210fedcba9876543210';
    connect(2, nextNonce);
    expect(fetchDisposals[0]).toHaveBeenCalledTimes(1);
    expect(xhrDisposals[0]).toHaveBeenCalledTimes(1);
    expect(jsonDisposals[0]).toHaveBeenCalledTimes(1);
    expect(fetchDisposals).toHaveLength(2);
    expect(jsonDisposals).toHaveLength(2);

    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'disconnect',
      nonce: nextNonce,
      generation: 2,
    });
    expect(fetchDisposals[1]).toHaveBeenCalledTimes(1);
    expect(xhrDisposals[1]).toHaveBeenCalledTimes(1);
    expect(jsonDisposals[1]).toHaveBeenCalledTimes(1);

    runtime.dispose();
    runtime.dispose();
  });

  it('publishes only changed authoritative Player API catalogs and stops polling on disconnect', () => {
    const window = new FakeWindow();
    const polls: Array<() => void> = [];
    const stopPolling = vi.fn();
    const readPlayerCatalog = vi.fn()
      .mockReturnValueOnce(ok({
        type: 'catalog' as const,
        titleId: 'title-1',
        authority: 'authoritative' as const,
        tracks: [{ id: 'en-main', language: 'en-US', kind: 'subtitle' as const }],
      }))
      .mockReturnValueOnce(ok({
        type: 'catalog' as const,
        titleId: 'title-1',
        authority: 'authoritative' as const,
        tracks: [{ id: 'en-main', language: 'en-US', kind: 'subtitle' as const }],
      }))
      .mockReturnValue(ok({
        type: 'catalog' as const,
        titleId: 'title-2',
        authority: 'authoritative' as const,
        tracks: [
          { id: 'en-main', language: 'en-US', kind: 'subtitle' as const },
          { id: 'zh-main', language: 'zh-CN', kind: 'subtitle' as const },
        ],
      }));
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog,
      scheduleCatalogPoll(task) {
        polls.push(task);
        return stopPolling;
      },
    });

    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    expect(window.sent.at(-1)?.data).toMatchObject({
      generation: 1,
      payload: { authority: 'authoritative', titleId: 'title-1' },
    });
    const sentAfterInitial = window.sent.length;
    polls[0]?.();
    expect(window.sent).toHaveLength(sentAfterInitial);
    window.location.pathname = '/watch/title-2';
    polls[0]?.();
    expect(window.sent.at(-1)?.data).toMatchObject({
      payload: {
        authority: 'authoritative',
        titleId: 'title-2',
        tracks: expect.arrayContaining([
          expect.objectContaining({ id: 'zh-main', language: 'zh-CN' }),
        ]),
      },
    });

    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'disconnect',
      nonce: NONCE,
      generation: 1,
    });
    expect(stopPolling).toHaveBeenCalledOnce();
  });

  it('uses MAIN-world player metadata after establishing its authoritative catalog', async () => {
    const window = new FakeWindow();
    const polls: Array<() => void> = [];
    const resources = [{
      url: 'https://cdn.nflximg.net/subtitle/title-1-en.vtt?token=private',
      titleId: 'title-1',
      resourceId: 'tt_1111111111111111',
      trackId: 'en-main',
      language: 'en',
      kind: 'subtitle' as const,
    }, {
      url: 'https://cdn.nflximg.net/subtitle/title-1-zh.vtt?token=private',
      titleId: 'title-1',
      resourceId: 'tt_2222222222222222',
      trackId: 'zh-main',
      language: 'zh-Hans',
      kind: 'subtitle' as const,
    }];
    const downloadCatalogTimedText = vi.fn(async (
      _fetcher,
      resource: NetflixCatalogDownloadResource,
    ) => ok({
      type: 'timed-text' as const,
      titleId: resource.titleId,
      resourceId: resource.resourceId,
      trackId: resource.trackId,
      language: resource.language,
      format: 'webvtt' as const,
      body: 'WEBVTT\n\n',
    }));

    installMainWorldNetflixRuntime({
      window,
      installFetch: () => ({ dispose: vi.fn() }),
      installXhr: () => ({ dispose: vi.fn() }),
      readPlayerCatalog: (
        _target: unknown,
        onMetadata?: (metadata: unknown) => void,
      ) => {
        onMetadata?.({ resources });
        return ok({
          type: 'catalog',
          titleId: 'title-1',
          authority: 'authoritative',
          tracks: [
            { id: 'en-main', language: 'en', kind: 'subtitle' },
            { id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' },
          ],
        });
      },
      scheduleCatalogPoll(task) {
        polls.push(task);
        return () => undefined;
      },
      extractCatalogResources: (metadata) => ok(
        (metadata as { resources: typeof resources }).resources,
      ),
      downloadCatalogTimedText,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledTimes(2));
    expect(window.sent.some(({ data }) =>
      (data as { payload?: { type?: string } }).payload?.type === 'catalog')).toBe(true);
    expect(JSON.stringify(window.sent)).not.toContain('token=private');

    polls[0]?.();
    await Promise.resolve();
    expect(downloadCatalogTimedText).toHaveBeenCalledTimes(2);
  });

  it('retries failed player metadata resources only after their signed URL changes', async () => {
    const window = new FakeWindow();
    const polls: Array<() => void> = [];
    let token = 'one';
    const resources = (): readonly NetflixCatalogDownloadResource[] => [{
      url: `https://cdn.nflximg.net/subtitle/title-1-en.vtt?token=${token}`,
      titleId: 'title-1',
      resourceId: 'tt_1111111111111111',
      trackId: 'en-main',
      language: 'en',
      kind: 'subtitle',
    }];
    const downloadCatalogTimedText = vi.fn(async () => err({
      code: 'netflix_timed_text_invalid_body' as const,
      message: 'Invalid body.',
      retryable: false,
    }));

    installMainWorldNetflixRuntime({
      window,
      installFetch: () => ({ dispose: vi.fn() }),
      installXhr: () => ({ dispose: vi.fn() }),
      readPlayerCatalog: (
        _target: unknown,
        onMetadata?: (metadata: unknown) => void,
      ) => {
        onMetadata?.({ resources: resources() });
        return ok({
          type: 'catalog',
          titleId: 'title-1',
          authority: 'authoritative',
          tracks: [{ id: 'en-main', language: 'en', kind: 'subtitle' }],
        });
      },
      scheduleCatalogPoll(task) {
        polls.push(task);
        return () => undefined;
      },
      extractCatalogResources: (metadata) => ok(
        (metadata as { resources: readonly NetflixCatalogDownloadResource[] }).resources,
      ),
      downloadCatalogTimedText,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledOnce());
    polls[0]?.();
    await Promise.resolve();
    expect(downloadCatalogTimedText).toHaveBeenCalledOnce();

    token = 'two';
    polls[0]?.();
    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(window.sent)).not.toContain('token=');
  });

  it('retags a uniquely matching manifest resource to the authoritative Player track', async () => {
    const window = new FakeWindow();
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    const rawResource: NetflixCatalogDownloadResource = {
      url: 'https://cdn.nflximg.net/subtitle/title-1-en.vtt?token=private',
      titleId: 'title-1',
      resourceId: 'tt_1111111111111111',
      trackId: 'manifest-en',
      language: 'en-US',
      kind: 'subtitle',
    };
    const downloadCatalogTimedText = vi.fn(async (
      _fetcher,
      resource: NetflixCatalogDownloadResource,
    ) => ok({
      type: 'timed-text' as const,
      titleId: resource.titleId,
      resourceId: resource.resourceId,
      trackId: resource.trackId,
      language: resource.language,
      format: 'webvtt' as const,
      body: 'WEBVTT\n\n',
    }));
    installMainWorldNetflixRuntime({
      window,
      installFetch: (_target, options) => {
        onCatalogMetadata = options.onCatalogMetadata;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      readPlayerCatalog: () => ok({
        type: 'catalog',
        titleId: 'title-1',
        authority: 'authoritative',
        tracks: [{ id: 'player-en', language: 'en', kind: 'subtitle' }],
      }),
      scheduleCatalogPoll: () => () => undefined,
      extractCatalogResources: () => ok([rawResource]),
      downloadCatalogTimedText,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    onCatalogMetadata?.({ trustedNetflixMetadata: true });
    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledOnce());

    expect(downloadCatalogTimedText.mock.calls[0]?.[1]).toMatchObject({
      trackId: 'player-en',
      language: 'en',
      kind: 'subtitle',
    });
    expect(window.sent.some(({ data }) => {
      const payload = (data as { payload?: { type?: string; trackId?: string } }).payload;
      return payload?.type === 'timed-text' && payload.trackId === 'player-en';
    })).toBe(true);
    expect(JSON.stringify(window.sent)).not.toContain('token=private');
  });

  it('does not retag an ambiguous manifest resource across two Player tracks', async () => {
    const window = new FakeWindow();
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    const downloadCatalogTimedText = vi.fn();
    installMainWorldNetflixRuntime({
      window,
      installFetch: (_target, options) => {
        onCatalogMetadata = options.onCatalogMetadata;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      readPlayerCatalog: () => ok({
        type: 'catalog',
        titleId: 'title-1',
        authority: 'authoritative',
        tracks: [
          { id: 'player-en-1', language: 'en-US', kind: 'subtitle' },
          { id: 'player-en-2', language: 'en-GB', kind: 'subtitle' },
        ],
      }),
      scheduleCatalogPoll: () => () => undefined,
      extractCatalogResources: () => ok([{
        url: 'https://cdn.nflximg.net/subtitle/title-1-en.vtt',
        titleId: 'title-1',
        resourceId: 'tt_1111111111111111',
        trackId: 'manifest-en',
        language: 'en',
        kind: 'subtitle',
      }]),
      downloadCatalogTimedText,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    onCatalogMetadata?.({ trustedNetflixMetadata: true });
    await Promise.resolve();

    expect(downloadCatalogTimedText).not.toHaveBeenCalled();
  });

  it('resets diagnostics and download state when the authoritative title changes without rebuilding MAIN probes', async () => {
    const window = new FakeWindow();
    const polls: Array<() => void> = [];
    const fetchDispose = vi.fn();
    const xhrDispose = vi.fn();
    let probeOptions: {
      onCatalogMetadata?(metadata: unknown): void;
      onDiagnostic?(code: 'metadata_candidate_observed'): void;
    } | undefined;
    let titleId = 'title-1';
    const resourcesFor = (nextTitleId: string) => [{
      url: `https://cdn.nflximg.net/subtitle/${nextTitleId}-en.vtt?token=secret`,
      titleId: nextTitleId,
      resourceId: nextTitleId === 'title-1'
        ? 'tt_1111111111111111'
        : 'tt_3333333333333333',
      trackId: 'en-main',
      language: 'en',
      kind: 'subtitle' as const,
    }, {
      url: `https://cdn.nflximg.net/subtitle/${nextTitleId}-zh.vtt?token=secret`,
      titleId: nextTitleId,
      resourceId: nextTitleId === 'title-1'
        ? 'tt_2222222222222222'
        : 'tt_4444444444444444',
      trackId: 'zh-main',
      language: 'zh-Hans',
      kind: 'subtitle' as const,
    }];
    const installFetch = vi.fn((_target, options) => {
      probeOptions = options;
      return { dispose: fetchDispose };
    });
    const installXhr = vi.fn(() => ({ dispose: xhrDispose }));
    const downloadCatalogTimedText = vi.fn(async (
      _fetcher,
      resource: NetflixCatalogDownloadResource,
    ) => resource.language === 'zh-Hans'
      ? err({
          code: 'netflix_timed_text_invalid_body' as const,
          message: 'Invalid body.',
          retryable: false,
        })
      : ok({
          type: 'timed-text' as const,
          titleId: resource.titleId,
          resourceId: resource.resourceId,
          trackId: resource.trackId,
          language: resource.language,
          format: 'webvtt' as const,
          body: 'WEBVTT\n\n',
        }));
    const diagnosticCodes = (): string[] => window.sent.flatMap(({ data }) => {
      const payload = (data as { readonly payload?: unknown }).payload;
      return typeof payload === 'object' && payload !== null &&
          Reflect.get(payload, 'type') === 'diagnostic' &&
          typeof Reflect.get(payload, 'code') === 'string'
        ? [Reflect.get(payload, 'code') as string]
        : [];
    });

    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => ok({
        type: 'catalog',
        titleId,
        authority: 'authoritative',
        tracks: [
          { id: 'en-main', language: 'en', kind: 'subtitle' },
          { id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' },
        ],
      }),
      scheduleCatalogPoll(task) {
        polls.push(task);
        return () => undefined;
      },
      installFetch,
      installXhr,
      extractCatalogResources: (metadata) => ok(
        (metadata as { resources: ReturnType<typeof resourcesFor> }).resources,
      ),
      downloadCatalogTimedText,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    probeOptions?.onDiagnostic?.('metadata_candidate_observed');
    probeOptions?.onCatalogMetadata?.({ resources: resourcesFor('title-1') });
    await vi.waitFor(() => expect(diagnosticCodes().filter(
      (code) => code === 'display_unavailable',
    )).toHaveLength(1));

    window.location.pathname = '/watch/title-2';
    titleId = 'title-2';
    polls[0]?.();
    probeOptions?.onDiagnostic?.('metadata_candidate_observed');
    probeOptions?.onCatalogMetadata?.({ resources: resourcesFor('title-2') });
    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(diagnosticCodes().filter(
      (code) => code === 'display_unavailable',
    )).toHaveLength(2));

    for (const code of [
      'metadata_candidate_observed',
      'metadata_resources_extracted',
      'download_candidate_approved',
      'download_started',
      'download_succeeded',
      'display_unavailable',
    ]) {
      expect(diagnosticCodes().filter((candidate) => candidate === code)).toHaveLength(2);
    }
    expect(installFetch).toHaveBeenCalledOnce();
    expect(installXhr).toHaveBeenCalledOnce();
    expect(fetchDispose).not.toHaveBeenCalled();
    expect(xhrDispose).not.toHaveBeenCalled();
  });

  it('resets route-scoped diagnostics after navigation even when no catalog was established', () => {
    const window = new FakeWindow();
    let onDiagnostic: ((code: 'metadata_candidate_observed') => void) | undefined;
    const installFetch = vi.fn((_target, options) => {
      onDiagnostic = options.onDiagnostic;
      return { dispose: vi.fn() };
    });
    const installXhr = vi.fn(() => ({ dispose: vi.fn() }));
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => err({
        code: 'netflix_player_api_unavailable' as const,
        message: 'Unavailable.',
        retryable: false,
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch,
      installXhr,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    onDiagnostic?.('metadata_candidate_observed');
    window.location.pathname = '/watch/title-2';
    onDiagnostic?.('metadata_candidate_observed');

    const observedDiagnostics = window.sent.filter(({ data }) => {
      const payload = (data as { readonly payload?: unknown }).payload;
      return typeof payload === 'object' && payload !== null &&
        Reflect.get(payload, 'type') === 'diagnostic' &&
        Reflect.get(payload, 'code') === 'metadata_candidate_observed';
    });
    expect(observedDiagnostics).toHaveLength(2);
    expect(installFetch).toHaveBeenCalledOnce();
    expect(installXhr).toHaveBeenCalledOnce();
  });

  it('does not bind a direct network body until matching authoritative metadata approves its resource', () => {
    const window = new FakeWindow();
    let probeOptions: {
      onTimedText(payload: {
        type: 'timed-text';
        resourceId: string;
        trackId: string;
        language: string;
        format: 'webvtt';
        body: string;
      }): void;
      onCatalogMetadata?(metadata: unknown): void;
    } | undefined;
    const resource = {
      titleId: 'title-1',
      resourceId: 'tt_0123456789abcdef',
      trackId: 'manifest-en',
      language: 'en',
      kind: 'subtitle' as const,
      url: 'https://cdn.nflximg.net/subtitle/en.vtt?token=main-only',
    };
    const runtime = installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => ok({
        type: 'catalog',
        titleId: 'title-1',
        authority: 'authoritative',
        tracks: [{ id: 'player-en', language: 'en-US', kind: 'subtitle' }],
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        probeOptions = options;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      extractCatalogResources: () => ok([resource]),
      downloadCatalogTimedText: () => new Promise(() => undefined),
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });
    const observed = {
      type: 'timed-text' as const,
      resourceId: resource.resourceId,
      trackId: resource.trackId,
      language: resource.language,
      format: 'webvtt' as const,
      body: 'WEBVTT\n\n',
    };
    const beforeUnboundBody = window.sent.length;

    probeOptions?.onTimedText(observed);
    expect(window.sent).toHaveLength(beforeUnboundBody);

    probeOptions?.onCatalogMetadata?.({ metadata: true });
    probeOptions?.onTimedText(observed);
    expect(window.sent.at(-1)?.data).toMatchObject({
      payload: {
        type: 'timed-text',
        titleId: 'title-1',
        resourceId: resource.resourceId,
        trackId: 'player-en',
        language: 'en-US',
      },
    });
    expect(JSON.stringify(window.sent.at(-1)?.data)).not.toContain('main-only');
    runtime.dispose();
  });

  it('forces missing English and Simplified Chinese tracks sequentially, binds their bodies, and restores playback state', () => {
    const window = new FakeWindow();
    let probeOptions: {
      currentTimedTextBinding?(): { titleId: string; trackId: string } | undefined;
      onTimedText(payload: {
        type: 'timed-text';
        resourceId: string;
        trackId: string;
        language: string;
        format: 'webvtt';
        body: string;
      }): void;
    } | undefined;
    const switchTo = vi.fn(() => true);
    const restore = vi.fn();
    const onTrackCaptureEvent = vi.fn();
    const preparePlayerTrackCapture = vi.fn(() => ok({
      titleId: 'title-1',
      originalTrackId: 'en-main',
      switchTo,
      restore,
    }));
    const runtime = installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: (_target, onMetadata) => {
        onMetadata?.({ titleId: 'title-1', timedtexttracks: [] });
        return ok({
          type: 'catalog',
          titleId: 'title-1',
          authority: 'authoritative',
          tracks: [
            { id: 'en-main', language: 'en', kind: 'closed-caption' },
            { id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' },
          ],
        });
      },
      preparePlayerTrackCapture,
      onTrackCaptureEvent,
      scheduleCatalogPoll: () => () => undefined,
      scheduleTrackCaptureTimeout: () => () => undefined,
      installFetch: (_target, options) => {
        probeOptions = options;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      extractCatalogResources: () => ok([]),
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    expect(preparePlayerTrackCapture).toHaveBeenCalledOnce();
    expect(switchTo).toHaveBeenNthCalledWith(1, 'zh-main');
    expect(onTrackCaptureEvent).toHaveBeenCalledWith({
      state: 'switch_started',
      language: 'zh-Hans',
    });
    expect(probeOptions?.currentTimedTextBinding?.()).toEqual({
      titleId: 'title-1',
      trackId: 'zh-main',
    });

    probeOptions?.onTimedText({
      type: 'timed-text',
      resourceId: 'tt_0123456789abcdef',
      trackId: 'zh-main',
      language: 'und',
      format: 'webvtt',
      body: 'WEBVTT\n\n00:00.000 --> 00:01.000\n你好',
    });
    expect(window.sent.at(-1)?.data).toMatchObject({
      payload: {
        type: 'timed-text',
        titleId: 'title-1',
        trackId: 'zh-main',
        language: 'zh-Hans',
      },
    });
    expect(switchTo).toHaveBeenNthCalledWith(2, 'en-main');
    expect(onTrackCaptureEvent).toHaveBeenCalledWith({
      state: 'body_captured',
      language: 'zh-Hans',
    });

    probeOptions?.onTimedText({
      type: 'timed-text',
      resourceId: 'tt_fedcba9876543210',
      trackId: 'en-main',
      language: 'und',
      format: 'webvtt',
      body: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello',
    });
    expect(window.sent.at(-1)?.data).toMatchObject({
      payload: {
        type: 'timed-text',
        titleId: 'title-1',
        trackId: 'en-main',
        language: 'en',
      },
    });
    expect(restore).toHaveBeenCalled();
    expect(onTrackCaptureEvent).toHaveBeenCalledWith({
      state: 'restored',
      language: 'en',
    });
    expect(probeOptions?.currentTimedTextBinding?.()).toBeUndefined();

    runtime.dispose();
  });

  it('binds a self-declared OCA TTML language to exactly one authoritative Player track', () => {
    const window = new FakeWindow();
    let probeOptions: {
      onTimedText(payload: {
        type: 'timed-text';
        resourceId: string;
        trackId: string;
        language: string;
        format: 'ttml';
        body: string;
      }): void;
    } | undefined;
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => ok({
        type: 'catalog',
        titleId: 'title-1',
        authority: 'authoritative',
        tracks: [
          { id: 'en-main', language: 'en', kind: 'closed-caption' },
          { id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' },
        ],
      }),
      preparePlayerTrackCapture: () => err({
        code: 'netflix_player_track_control_unavailable' as const,
        message: 'Unavailable.',
        retryable: false,
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        probeOptions = options;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    probeOptions?.onTimedText({
      type: 'timed-text',
      resourceId: 'tt_0123456789abcdef',
      trackId: 'oca_0123456789abcdef',
      language: 'zh-Hans',
      format: 'ttml',
      body: '<tt xml:lang="zh-Hans"><body /></tt>',
    });

    expect(window.sent.at(-1)?.data).toMatchObject({
      payload: {
        type: 'timed-text',
        titleId: 'title-1',
        trackId: 'zh-main',
        language: 'zh-Hans',
      },
    });
  });

  it('downloads catalog-declared dual-track bodies in MAIN world without bridging signed URLs', async () => {
    const window = new FakeWindow();
    const probeOptions: Array<{ onCatalogMetadata?: (metadata: unknown) => void }> = [];
    const signedUrl = 'https://cdn.nflximg.net/subtitle/en.vtt?token=secret';
    const downloadCatalogTimedText = vi.fn(async (_fetcher, resource: {
      titleId: string;
      resourceId: string;
      trackId: string;
      language: string;
    }) => ok({
      type: 'timed-text' as const,
      titleId: resource.titleId,
      resourceId: resource.resourceId,
      trackId: resource.trackId,
      language: resource.language,
      format: 'webvtt' as const,
      body: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello',
    }));
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => ok({
        type: 'catalog',
        titleId: 'title-1',
        authority: 'authoritative',
        tracks: [{ id: 'en-main', language: 'en', kind: 'subtitle' }],
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        probeOptions.push(options);
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      extractCatalogResources: () => ok([{
        url: signedUrl,
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        language: 'en',
        kind: 'subtitle' as const,
      }]),
      downloadCatalogTimedText,
    });

    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });
    probeOptions[0]?.onCatalogMetadata?.({ signedUrl });
    probeOptions[0]?.onCatalogMetadata?.({ signedUrl });

    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(window.sent
      .map(({ data }) => (data as { readonly payload?: unknown }).payload)
      .find((payload) =>
        (payload as { readonly type?: unknown } | undefined)?.type === 'timed-text'))
      .toMatchObject({
        type: 'timed-text',
        titleId: 'title-1',
        trackId: 'en-main',
        language: 'en',
      }));
    expect(JSON.stringify(window.sent)).not.toContain(signedUrl);
  });

  it('uses route-matched Netflix metadata as a dual-track fallback when the private player API is unavailable', async () => {
    const window = new FakeWindow();
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    const resources = [
      {
        url: 'https://cdn.nflximg.net/subtitle/en.vtt?token=secret-en',
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        language: 'en',
        kind: 'closed-caption' as const,
      },
      {
        url: 'https://cdn.nflximg.net/subtitle/zh.vtt?token=secret-zh',
        titleId: 'title-1',
        resourceId: 'tt_fedcba9876543210',
        trackId: 'zh-main',
        language: 'zh-Hans',
        kind: 'subtitle' as const,
      },
    ];
    const downloadCatalogTimedText = vi.fn(async (_fetcher, resource: typeof resources[number]) => ok({
      type: 'timed-text' as const,
      titleId: resource.titleId,
      resourceId: resource.resourceId,
      trackId: resource.trackId,
      language: resource.language,
      format: 'webvtt' as const,
      body: 'WEBVTT\n\n',
    }));
    const downloadEvents: Array<{ readonly state: string; readonly language: string }> = [];
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => err({
        code: 'netflix_player_api_unavailable' as const,
        message: 'Unavailable.',
        retryable: false,
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        onCatalogMetadata = options.onCatalogMetadata;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      extractCatalogResources: () => ok(resources),
      downloadCatalogTimedText,
      onDownloadEvent: (event) => downloadEvents.push(event),
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    onCatalogMetadata?.({ trustedNetflixMetadata: true });

    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledTimes(2));
    expect(downloadEvents).toEqual([
      { state: 'started', language: 'en' },
      { state: 'started', language: 'zh-Hans' },
      { state: 'succeeded', language: 'en' },
      { state: 'succeeded', language: 'zh-Hans' },
    ]);
    const diagnosticCodes = window.sent.flatMap(({ data }) => {
      const payload = (data as { readonly payload?: unknown }).payload;
      return typeof payload === 'object' && payload !== null &&
          Reflect.get(payload, 'type') === 'diagnostic' &&
          typeof Reflect.get(payload, 'code') === 'string'
        ? [Reflect.get(payload, 'code') as string]
        : [];
    });
    expect(diagnosticCodes).toEqual(expect.arrayContaining([
      'metadata_resources_extracted',
      'download_candidate_approved',
      'download_started',
    ]));
    expect(window.sent.some(({ data }) => JSON.stringify(data).includes('"authority":"authoritative"'))).toBe(true);
    expect(JSON.stringify(window.sent)).not.toContain('secret-en');
    expect(JSON.stringify(window.sent)).not.toContain('secret-zh');
  });

  it('treats an empty player catalog as transient and binds later route metadata', async () => {
    const window = new FakeWindow();
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    const resources = [{
      url: 'https://cdn.nflximg.net/subtitle/en.vtt?token=private-en',
      titleId: 'title-1',
      resourceId: 'tt_0123456789abcdef',
      trackId: 'en-main',
      language: 'en',
      kind: 'subtitle' as const,
    }, {
      url: 'https://cdn.nflximg.net/subtitle/zh.vtt?token=private-zh',
      titleId: 'title-1',
      resourceId: 'tt_fedcba9876543210',
      trackId: 'zh-main',
      language: 'zh-Hans',
      kind: 'subtitle' as const,
    }];
    const onCatalogMatchDiagnostic = vi.fn();
    const downloadCatalogTimedText = vi.fn(async (
      _fetcher,
      resource: NetflixCatalogDownloadResource,
    ) => ok({
      type: 'timed-text' as const,
      titleId: resource.titleId,
      resourceId: resource.resourceId,
      trackId: resource.trackId,
      language: resource.language,
      format: 'webvtt' as const,
      body: 'WEBVTT\n\n',
    }));
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: (
        _target: unknown,
        onMetadata?: (metadata: unknown) => void,
      ) => {
        onMetadata?.({ resources: [] });
        return ok({
          type: 'catalog',
          titleId: 'title-1',
          authority: 'authoritative',
          tracks: [],
        });
      },
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        onCatalogMetadata = options.onCatalogMetadata;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      extractCatalogResources: (metadata) => ok(
        (metadata as { resources: typeof resources }).resources,
      ),
      downloadCatalogTimedText,
      onCatalogMatchDiagnostic,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    const beforeNetwork = window.sent.flatMap(({ data }) => {
      const payload = (data as { readonly payload?: unknown }).payload;
      return typeof payload === 'object' && payload !== null &&
          Reflect.get(payload, 'type') === 'diagnostic'
        ? [Reflect.get(payload, 'code')]
        : [];
    });
    expect(beforeNetwork).not.toContain('metadata_resources_extracted');
    expect(beforeNetwork).not.toContain('download_candidate_unmatched');
    expect(onCatalogMatchDiagnostic).not.toHaveBeenCalled();

    onCatalogMetadata?.({ resources });

    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledTimes(2));
    expect(onCatalogMatchDiagnostic).not.toHaveBeenCalled();
    expect(JSON.stringify(window.sent)).not.toContain('private-en');
    expect(JSON.stringify(window.sent)).not.toContain('private-zh');
  });

  it('replaces a route metadata fallback after navigating to a second watch title without rebuilding MAIN probes', async () => {
    const window = new FakeWindow();
    const fetchDispose = vi.fn();
    const xhrDispose = vi.fn();
    const polls: Array<() => void> = [];
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    let onDiagnostic: ((code: 'metadata_candidate_observed') => void) | undefined;
    const resourcesFor = (titleId: string) => [{
      url: `https://cdn.nflximg.net/subtitle/${titleId}-en.vtt?token=secret`,
      titleId,
      resourceId: titleId === 'title-1'
        ? 'tt_1111111111111111'
        : 'tt_3333333333333333',
      trackId: 'en-main',
      language: 'en',
      kind: 'subtitle' as const,
    }, {
      url: `https://cdn.nflximg.net/subtitle/${titleId}-zh.vtt?token=secret`,
      titleId,
      resourceId: titleId === 'title-1'
        ? 'tt_2222222222222222'
        : 'tt_4444444444444444',
      trackId: 'zh-main',
      language: 'zh-Hans',
      kind: 'subtitle' as const,
    }];
    const installFetch = vi.fn((_target, options) => {
      onCatalogMetadata = options.onCatalogMetadata;
      onDiagnostic = options.onDiagnostic;
      return { dispose: fetchDispose };
    });
    const installXhr = vi.fn(() => ({ dispose: xhrDispose }));
    const downloadCatalogTimedText = vi.fn(async (
      _fetcher,
      resource: NetflixCatalogDownloadResource,
    ) => ok({
      type: 'timed-text' as const,
      titleId: resource.titleId,
      resourceId: resource.resourceId,
      trackId: resource.trackId,
      language: resource.language,
      format: 'webvtt' as const,
      body: 'WEBVTT\n\n',
    }));
    const readPlayerCatalog = vi.fn()
      .mockReturnValueOnce(ok({
        type: 'catalog' as const,
        titleId: 'title-1',
        authority: 'authoritative' as const,
        tracks: [
          { id: 'en-main', language: 'en', kind: 'subtitle' as const },
          { id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' as const },
        ],
      }))
      .mockReturnValueOnce(err({
        code: 'netflix_player_api_unavailable' as const,
        message: 'Unavailable.',
        retryable: false,
      }))
      .mockReturnValue(ok({
        type: 'catalog' as const,
        titleId: 'title-1',
        authority: 'authoritative' as const,
        tracks: [
          { id: 'en-main', language: 'en', kind: 'subtitle' as const },
          { id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' as const },
        ],
      }));

    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog,
      scheduleCatalogPoll(task) {
        polls.push(task);
        return () => undefined;
      },
      installFetch,
      installXhr,
      extractCatalogResources: (metadata) => ok(
        (metadata as { resources: ReturnType<typeof resourcesFor> }).resources,
      ),
      downloadCatalogTimedText,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    onDiagnostic?.('metadata_candidate_observed');
    onCatalogMetadata?.({ resources: resourcesFor('title-1') });
    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledTimes(2));

    window.location.pathname = '/watch/title-2';
    onDiagnostic?.('metadata_candidate_observed');
    onCatalogMetadata?.({ resources: resourcesFor('title-2') });
    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledTimes(4));
    expect(readPlayerCatalog).toHaveBeenCalledTimes(2);

    polls[0]?.();
    onDiagnostic?.('metadata_candidate_observed');
    onCatalogMetadata?.({ resources: resourcesFor('title-2') });
    await Promise.resolve();
    await Promise.resolve();
    expect(downloadCatalogTimedText).toHaveBeenCalledTimes(4);

    window.location.pathname = '/watch/title-1';
    onDiagnostic?.('metadata_candidate_observed');
    expect(readPlayerCatalog).toHaveBeenCalledTimes(4);

    const authoritativeTitles = window.sent.flatMap(({ data }) => {
      const payload = (data as { readonly payload?: unknown }).payload;
      return typeof payload === 'object' && payload !== null &&
          Reflect.get(payload, 'type') === 'catalog' &&
          Reflect.get(payload, 'authority') === 'authoritative' &&
          typeof Reflect.get(payload, 'titleId') === 'string'
        ? [Reflect.get(payload, 'titleId') as string]
        : [];
    });
    expect(authoritativeTitles).toEqual(['title-1', 'title-2', 'title-1']);
    const observedDiagnostics = window.sent.filter(({ data }) => {
      const payload = (data as { readonly payload?: unknown }).payload;
      return typeof payload === 'object' && payload !== null &&
        Reflect.get(payload, 'type') === 'diagnostic' &&
        Reflect.get(payload, 'code') === 'metadata_candidate_observed';
    });
    expect(observedDiagnostics).toHaveLength(3);
    expect(installFetch).toHaveBeenCalledOnce();
    expect(installXhr).toHaveBeenCalledOnce();
    expect(fetchDispose).not.toHaveBeenCalled();
    expect(xhrDispose).not.toHaveBeenCalled();
  });

  it('does not promote metadata fallback unless both target languages match the current watch route', async () => {
    const window = new FakeWindow();
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    const downloadCatalogTimedText = vi.fn();
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => err({
        code: 'netflix_player_api_unavailable' as const,
        message: 'Unavailable.',
        retryable: false,
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        onCatalogMetadata = options.onCatalogMetadata;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      extractCatalogResources: () => ok([{
        url: 'https://cdn.nflximg.net/subtitle/en.vtt?token=secret',
        titleId: 'another-title',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        language: 'en',
        kind: 'subtitle' as const,
      }]),
      downloadCatalogTimedText,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    onCatalogMetadata?.({ trustedNetflixMetadata: true });
    await Promise.resolve();

    expect(downloadCatalogTimedText).not.toHaveBeenCalled();
    expect(window.sent.some(({ data }) => JSON.stringify(data).includes('"authority":"authoritative"'))).toBe(false);
  });

  it('does not report global unavailability when an alternate resource for the same required track succeeds', async () => {
    const window = new FakeWindow();
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    const resources = [
      {
        url: 'https://cdn.nflximg.net/subtitle/en-a.vtt?token=a',
        titleId: 'title-1',
        resourceId: 'tt_1111111111111111',
        trackId: 'en-main',
        language: 'en',
        kind: 'subtitle' as const,
      },
      {
        url: 'https://cdn.nflximg.net/subtitle/en-b.vtt?token=b',
        titleId: 'title-1',
        resourceId: 'tt_2222222222222222',
        trackId: 'en-main',
        language: 'en',
        kind: 'subtitle' as const,
      },
      {
        url: 'https://cdn.nflximg.net/subtitle/zh.vtt?token=c',
        titleId: 'title-1',
        resourceId: 'tt_3333333333333333',
        trackId: 'zh-main',
        language: 'zh-Hans',
        kind: 'subtitle' as const,
      },
    ];
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => err({
        code: 'netflix_player_api_unavailable' as const,
        message: 'Unavailable.',
        retryable: false,
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        onCatalogMetadata = options.onCatalogMetadata;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      extractCatalogResources: () => ok(resources),
      downloadCatalogTimedText: async (_fetcher, resource) =>
        resource.resourceId === 'tt_1111111111111111'
          ? err({
              code: 'netflix_timed_text_invalid_body' as const,
              message: 'Invalid body.',
              retryable: false,
            })
          : ok({
              type: 'timed-text' as const,
              titleId: resource.titleId,
              resourceId: resource.resourceId,
              trackId: resource.trackId,
              language: resource.language,
              format: 'webvtt' as const,
              body: 'WEBVTT\n\n',
            }),
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    onCatalogMetadata?.({ trustedNetflixMetadata: true });
    await vi.waitFor(() => expect(window.sent.some(({ data }) =>
      JSON.stringify(data).includes('"type":"timed-text"'))).toBe(true));

    expect(window.sent.some(({ data }) => JSON.stringify(data).includes(
      '"code":"display_unavailable"',
    ))).toBe(false);
  });

  it('aborts in-flight catalog downloads and suppresses their late bodies on disconnect', async () => {
    const window = new FakeWindow();
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    let resolveDownload: ((value: ReturnType<typeof ok>) => void) | undefined;
    let downloadSignal: AbortSignal | undefined;
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => ok({
        type: 'catalog',
        titleId: 'title-1',
        authority: 'authoritative',
        tracks: [{ id: 'en-main', language: 'en', kind: 'subtitle' }],
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        onCatalogMetadata = options.onCatalogMetadata;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      extractCatalogResources: () => ok([{
        url: 'https://cdn.nflximg.net/subtitle/en.vtt?token=secret',
        titleId: 'title-1',
        resourceId: 'tt_fedcba9876543210',
        trackId: 'en-main',
        language: 'en',
        kind: 'subtitle' as const,
      }]),
      downloadCatalogTimedText: (_fetcher, _resource, options) => {
        downloadSignal = options?.signal;
        return new Promise((resolve) => {
          resolveDownload = resolve as (value: ReturnType<typeof ok>) => void;
        }) as never;
      },
    });
    const control = {
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      nonce: NONCE,
      generation: 3,
    } as const;
    window.emit({ ...control, type: 'connect' });
    onCatalogMetadata?.({ metadata: true });
    expect(downloadSignal?.aborted).toBe(false);

    window.emit({ ...control, type: 'disconnect' });
    expect(downloadSignal?.aborted).toBe(true);
    const sentBeforeLateBody = window.sent.length;
    resolveDownload?.(ok({
      type: 'timed-text',
      titleId: 'title-1',
      resourceId: 'tt_fedcba9876543210',
      trackId: 'en-main',
      language: 'en',
      format: 'webvtt',
      body: 'WEBVTT\n\n',
    }));
    await Promise.resolve();
    expect(window.sent).toHaveLength(sentBeforeLateBody);
  });

  it('accepts metadata resources only when title and a unique descriptor match the latest authoritative catalog', async () => {
    const window = new FakeWindow();
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    let catalog = {
      type: 'catalog' as const,
      titleId: 'title-1',
      authority: 'authoritative' as const,
      tracks: [{ id: 'en-main', language: 'en', kind: 'subtitle' as const }],
    };
    const polls: Array<() => void> = [];
    const downloadCatalogTimedText = vi.fn(async (_fetcher, resource: {
      titleId: string;
      resourceId: string;
      trackId: string;
      language: string;
    }) => ok({
      type: 'timed-text' as const,
      titleId: resource.titleId,
      resourceId: resource.resourceId,
      trackId: resource.trackId,
      language: resource.language,
      format: 'webvtt' as const,
      body: 'WEBVTT\n\n',
    }));
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => ok(catalog),
      scheduleCatalogPoll(task) {
        polls.push(task);
        return () => undefined;
      },
      installFetch: (_target, options) => {
        onCatalogMetadata = options.onCatalogMetadata;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      extractCatalogResources: (metadata) => ok([
        (metadata as { resource: {
          titleId: string;
          resourceId: string;
          trackId: string;
          language: string;
          kind: 'subtitle';
          url: string;
        } }).resource,
      ]),
      downloadCatalogTimedText,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });
    const resource = {
      titleId: 'title-1',
      resourceId: 'tt_0123456789abcdef',
      trackId: 'en-main',
      language: 'en',
      kind: 'subtitle' as const,
      url: 'https://cdn.nflximg.net/subtitle/en.vtt?token=secret',
    };

    onCatalogMetadata?.({ resource: { ...resource, titleId: 'title-2' } });
    onCatalogMetadata?.({
      resource: { ...resource, trackId: 'fr-main', language: 'fr' },
    });
    await Promise.resolve();
    expect(downloadCatalogTimedText).not.toHaveBeenCalled();

    onCatalogMetadata?.({ resource });
    await vi.waitFor(() => expect(downloadCatalogTimedText).toHaveBeenCalledOnce());

    catalog = { ...catalog, titleId: 'title-2' };
    polls[0]?.();
    onCatalogMetadata?.({ resource });
    await Promise.resolve();
    expect(downloadCatalogTimedText).toHaveBeenCalledOnce();
  });

  it('reports only aggregate rejection reasons when metadata resources cannot bind', () => {
    const window = new FakeWindow();
    let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
    const onCatalogMatchDiagnostic = vi.fn();
    installMainWorldNetflixRuntime({
      window,
      readPlayerCatalog: () => ok({
        type: 'catalog',
        titleId: 'title-1',
        authority: 'authoritative',
        tracks: [
          { id: 'player-en', language: 'en', kind: 'closed-caption' },
          { id: 'player-zh', language: 'zh-Hans', kind: 'subtitle' },
        ],
      }),
      scheduleCatalogPoll: () => () => undefined,
      installFetch: (_target, options) => {
        onCatalogMetadata = options.onCatalogMetadata;
        return { dispose: vi.fn() };
      },
      installXhr: () => ({ dispose: vi.fn() }),
      installJsonParse: () => ({ dispose: vi.fn() }),
      extractCatalogResources: () => ok([
        {
          titleId: 'another-title',
          resourceId: 'tt_0123456789abcdef',
          trackId: 'manifest-en',
          language: 'en',
          kind: 'closed-caption',
          url: 'https://cdn.nflximg.net/subtitle/en.vtt?token=top-secret',
        },
        {
          titleId: 'title-1',
          resourceId: 'tt_fedcba9876543210',
          trackId: 'manifest-en-subtitle',
          language: 'en',
          kind: 'subtitle',
          url: 'https://cdn.nflximg.net/subtitle/en-alt.vtt?token=other-secret',
        },
      ]),
      onCatalogMatchDiagnostic,
    });
    window.emit({
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 1,
    });

    onCatalogMetadata?.({ metadata: true });

    expect(onCatalogMatchDiagnostic).toHaveBeenCalledWith({
      source: 'network',
      resourceCount: 2,
      catalogTrackCount: 2,
      rejections: {
        noAuthoritativeCatalog: 0,
        titleMismatch: 1,
        unsupportedLanguage: 0,
        languageCategoryMismatch: 0,
        kindMismatch: 1,
        ambiguousTrack: 0,
        bindingRejected: 0,
      },
    });
    expect(JSON.stringify(onCatalogMatchDiagnostic.mock.calls)).not.toMatch(
      /top-secret|other-secret|nflximg|manifest-|player-/u,
    );
  });

  it('retries transient download failures with bounded backoff without permanently poisoning the resource', async () => {
    vi.useFakeTimers();
    try {
      const window = new FakeWindow();
      let onCatalogMetadata: ((metadata: unknown) => void) | undefined;
      const resource = {
        titleId: 'title-1',
        resourceId: 'tt_0123456789abcdef',
        trackId: 'en-main',
        language: 'en',
        kind: 'subtitle' as const,
        url: 'https://cdn.nflximg.net/subtitle/en.vtt?token=secret',
      };
      const downloadCatalogTimedText = vi.fn(async () => err({
        code: 'netflix_timed_text_fetch_failed' as const,
        message: 'Sanitized transient failure.',
        retryable: false,
      }));
      installMainWorldNetflixRuntime({
        window,
        readPlayerCatalog: () => ok({
          type: 'catalog',
          titleId: 'title-1',
          authority: 'authoritative',
          tracks: [{ id: 'en-main', language: 'en', kind: 'subtitle' }],
        }),
        scheduleCatalogPoll: () => () => undefined,
        installFetch: (_target, options) => {
          onCatalogMetadata = options.onCatalogMetadata;
          return { dispose: vi.fn() };
        },
        installXhr: () => ({ dispose: vi.fn() }),
        extractCatalogResources: () => ok([resource]),
        downloadCatalogTimedText,
      });
      window.emit({
        protocol: 'subtwin.netflix.bridge',
        version: 1,
        source: NETFLIX_CONTROL_SOURCE,
        type: 'connect',
        nonce: NONCE,
        generation: 1,
      });

      onCatalogMetadata?.({ metadata: true });
      await Promise.resolve();
      expect(downloadCatalogTimedText).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(downloadCatalogTimedText).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(downloadCatalogTimedText).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(downloadCatalogTimedText).toHaveBeenCalledTimes(3);
      expect(window.sent.at(-1)?.data).toMatchObject({
        payload: {
          type: 'diagnostic',
          code: 'display_unavailable',
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(downloadCatalogTimedText).toHaveBeenCalledTimes(3);

      onCatalogMetadata?.({ metadata: true });
      await Promise.resolve();
      expect(downloadCatalogTimedText).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows the same generation to retry after a probe installer fails', () => {
    const window = new FakeWindow();
    const failedFetchDispose = vi.fn();
    const installedFetchDispose = vi.fn();
    const installedXhrDispose = vi.fn();
    const installFetch = vi
      .fn()
      .mockReturnValueOnce({ dispose: failedFetchDispose })
      .mockReturnValueOnce({ dispose: installedFetchDispose });
    const installXhr = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('temporary install failure');
      })
      .mockReturnValueOnce({ dispose: installedXhrDispose });
    const runtime = installMainWorldNetflixRuntime({
      window,
      installFetch,
      installXhr,
    });
    const control = {
      protocol: 'subtwin.netflix.bridge',
      version: 1,
      source: NETFLIX_CONTROL_SOURCE,
      type: 'connect',
      nonce: NONCE,
      generation: 7,
    } as const;

    window.emit(control);
    expect(failedFetchDispose).toHaveBeenCalledTimes(1);

    window.emit(control);
    expect(installFetch).toHaveBeenCalledTimes(2);
    expect(installXhr).toHaveBeenCalledTimes(2);

    runtime.dispose();
    expect(installedFetchDispose).toHaveBeenCalledTimes(1);
    expect(installedXhrDispose).toHaveBeenCalledTimes(1);
  });
});
