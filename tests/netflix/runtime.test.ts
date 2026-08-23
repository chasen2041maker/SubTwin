import { describe, expect, it, vi } from 'vitest';

import {
  NETFLIX_CONTROL_SOURCE,
  createIsolatedNetflixBridge,
  installMainWorldNetflixRuntime,
  parseNetflixControlEvent,
  type NetflixRuntimeWindow,
} from '../../src/netflix/runtime';
import { err, ok } from '../../src/shared/result';

const NONCE = '0123456789abcdef0123456789abcdef';

class FakeXhr {
  open(): void {}
  send(): void {}
}

class FakeWindow implements NetflixRuntimeWindow {
  readonly location = { origin: 'https://www.netflix.com' };
  readonly sent: Array<{ readonly data: unknown; readonly targetOrigin: string }> = [];
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  fetch = vi.fn(async () => {
    throw new Error('not used by this unit test');
  });

  XMLHttpRequest = FakeXhr as never;

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

    const firstOptions = fetchOptions[0] as {
      onTimedText(payload: unknown): void;
      onCatalog(payload: unknown): void;
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

    const nextNonce = 'fedcba9876543210fedcba9876543210';
    connect(2, nextNonce);
    expect(fetchDisposals[0]).toHaveBeenCalledTimes(1);
    expect(xhrDisposals[0]).toHaveBeenCalledTimes(1);
    expect(fetchDisposals).toHaveLength(2);

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
      trackId: 'en-main',
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
        tracks: [{ id: 'en-main', language: 'en-US', kind: 'subtitle' }],
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
      },
    });
    expect(JSON.stringify(window.sent.at(-1)?.data)).not.toContain('main-only');
    runtime.dispose();
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
    await vi.waitFor(() => expect(window.sent.at(-1)?.data).toMatchObject({
      payload: {
        type: 'timed-text',
        titleId: 'title-1',
        trackId: 'en-main',
        language: 'en',
      },
    }));
    expect(JSON.stringify(window.sent)).not.toContain(signedUrl);
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

  it('accepts metadata resources only when title and track match the latest authoritative catalog', async () => {
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
    onCatalogMetadata?.({ resource: { ...resource, trackId: 'fr-main' } });
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
