import { describe, expect, it, vi } from 'vitest';

import {
  NETFLIX_CONTROL_SOURCE,
  createIsolatedNetflixBridge,
  installMainWorldNetflixRuntime,
  parseNetflixControlEvent,
  type NetflixRuntimeWindow,
} from '../../src/netflix/runtime';

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
    firstOptions.onTimedText({
      type: 'timed-text',
      resourceId: 'tt_0123456789abcdef',
      trackId: 'en-main',
      language: 'en',
      format: 'webvtt',
      body: 'WEBVTT\n\n',
    });
    expect(window.sent.at(-1)?.targetOrigin).toBe('https://www.netflix.com');
    expect(window.sent.at(-1)?.data).toMatchObject({
      nonce: NONCE,
      generation: 1,
      payload: { type: 'timed-text' },
    });
    firstOptions.onCatalog({
      type: 'catalog',
      titleId: 'title-1',
      authority: 'provisional',
      tracks: [{ id: 'en-main', language: 'en', kind: 'subtitle' }],
    });
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
