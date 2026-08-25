import { describe, expect, it, vi } from 'vitest';

import {
  canonicalizeNetflixTimedTextResource,
  extractCatalogObservation,
  installFetchProbe,
  installXhrProbe,
  sniffTimedText,
  type FetchTargetLike,
  type ProbeResponseLike,
  type XhrConstructorLike,
} from '../../src/netflix/probe';

const VTT_URL =
  'https://cdn.nflxvideo.net/timedtext/range/0-999/track.vtt?lang=en&token=secret';
const OPAQUE_OCA_URL =
  'https://ipv4-c001-lax001.1.oca.nflxvideo.net/?o=opaque-object&v=video-1&e=9999999999';

function headers(values: Readonly<Record<string, string>>) {
  return {
    get(name: string): string | null {
      const entry = Object.entries(values).find(
        ([key]) => key.toLowerCase() === name.toLowerCase(),
      );
      return entry?.[1] ?? null;
    },
  };
}

function response(body: string, overrides: Partial<ProbeResponseLike> = {}): ProbeResponseLike {
  return {
    url: VTT_URL,
    headers: headers({
      'content-type': 'text/vtt',
      'content-length': String(new TextEncoder().encode(body).byteLength),
    }),
    clone: vi.fn(() => response(body)),
    text: async () => body,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await Promise.resolve();
}

describe('Netflix timed-text candidate validation', () => {
  it('canonicalizes range segments and secrets to an opaque resource identity without merging languages', () => {
    const first = canonicalizeNetflixTimedTextResource(VTT_URL);
    const nextRange = canonicalizeNetflixTimedTextResource(
      'https://cdn.nflxvideo.net/timedtext/range/1000-1999/track.vtt?token=other&lang=en',
    );
    const chinese = canonicalizeNetflixTimedTextResource(
      'https://cdn.nflxvideo.net/timedtext/range/0-999/track.vtt?lang=zh-Hans&token=secret',
    );

    expect(first.ok && nextRange.ok && first.value.resourceId).toBe(
      nextRange.ok ? nextRange.value.resourceId : '',
    );
    expect(first.ok && chinese.ok && first.value.resourceId).not.toBe(
      chinese.ok ? chinese.value.resourceId : '',
    );
    if (first.ok) {
      expect(first.value.resourceId).toMatch(/^tt_[a-f0-9]{16}$/);
      expect(first.value).toMatchObject({
        trackId: first.value.resourceId,
        language: 'en',
      });
      expect(JSON.stringify(first.value)).not.toContain('secret');
      expect(JSON.stringify(first.value)).not.toContain('https://');
    }
  });

  it('canonicalizes rotating signed path segments without exposing them', () => {
    const first = canonicalizeNetflixTimedTextResource(
      'https://cdn.nflxvideo.net/token/first-secret/timedtext/range/0-99/track.vtt?lang=en',
    );
    const second = canonicalizeNetflixTimedTextResource(
      'https://ipv4-c999.nflxvideo.net/token/second-secret/timedtext/range/100-199/track.vtt?lang=en',
    );

    expect(first.ok && second.ok && first.value.resourceId).toBe(
      second.ok ? second.value.resourceId : '',
    );
  });

  it('sorts stable query components by code unit for locale-independent identity', () => {
    const result = canonicalizeNetflixTimedTextResource(
      'https://cdn.nflxvideo.net/timedtext/track.vtt?lang=a&lang=Z',
    );

    expect(result).toEqual({
      ok: true,
      value: {
        resourceId: 'tt_b567f71430247724',
        trackId: 'tt_b567f71430247724',
        language: 'und',
      },
    });
  });

  it.each([
    'http://cdn.nflxvideo.net/timedtext/track.vtt',
    'https://nflxvideo.net.evil.example/timedtext/track.vtt',
    'https://www.netflix.com/api/shakti/drm/license',
  ])('rejects non-HTTPS, non-owned, or non-subtitle candidates', (url) => {
    expect(canonicalizeNetflixTimedTextResource(url).ok).toBe(false);
  });

  it('requires a supported content type, bounded size, and WebVTT/TTML first chunk', () => {
    expect(
      sniffTimedText({
        contentType: 'text/vtt; charset=utf-8',
        contentLength: null,
        firstChunk: '\uFEFF WEBVTT\n\n',
      }),
    ).toEqual({ ok: true, value: { format: 'webvtt' } });
    expect(
      sniffTimedText({
        contentType: 'application/ttml+xml',
        contentLength: 100,
        firstChunk: '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml">',
      }),
    ).toEqual({ ok: true, value: { format: 'ttml' } });
    expect(
      sniffTimedText({
        contentType: 'video/mp4',
        contentLength: 10,
        firstChunk: 'WEBVTT',
      }).ok,
    ).toBe(false);
    expect(
      sniffTimedText({
        contentType: 'text/vtt',
        contentLength: 10 * 1024 * 1024 + 1,
        firstChunk: 'WEBVTT',
      }).ok,
    ).toBe(false);
    expect(
      sniffTimedText({
        contentType: 'text/plain',
        contentLength: null,
        firstChunk: '<html>not subtitles</html>',
      }).ok,
    ).toBe(false);
  });
});

describe('Netflix fetch instrumentation', () => {
  it('accepts an unbound opaque OCA TTML only when its root declares one valid language', async () => {
    const body = '<?xml version="1.0"?><tt xml:lang="zh-Hans" xmlns="http://www.w3.org/ns/ttml"><body /></tt>';
    const captured = vi.fn();
    const target: FetchTargetLike = {
      fetch: vi.fn(async () => response(body, {
        url: OPAQUE_OCA_URL,
        headers: headers({
          'content-type': 'text/xml',
          'content-length': String(new TextEncoder().encode(body).byteLength),
        }),
      })),
    };
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: captured,
    });

    await target.fetch(OPAQUE_OCA_URL);
    await settle();

    expect(captured).toHaveBeenCalledWith(expect.objectContaining({
      language: 'zh-Hans',
      format: 'ttml',
      body,
    }));
    handle.dispose();
  });

  it('captures an opaque Netflix OCA subtitle only while an authoritative track binding is active', async () => {
    const body = 'WEBVTT\n\n00:00.000 --> 00:01.000\n你好';
    const captured = vi.fn();
    const target: FetchTargetLike = {
      fetch: vi.fn(async () => response(body, { url: OPAQUE_OCA_URL })),
    };
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      currentTimedTextBinding: () => ({
        titleId: 'title-1',
        trackId: 'zh-main',
      }),
      onTimedText: captured,
    });

    await target.fetch(OPAQUE_OCA_URL);
    await settle();

    expect(captured).toHaveBeenCalledWith({
      type: 'timed-text',
      resourceId: expect.stringMatching(/^tt_/u),
      trackId: 'zh-main',
      language: 'und',
      format: 'webvtt',
      body,
    });
    handle.dispose();

    const rejected = vi.fn();
    const withoutBinding = installFetchProbe(target, {
      generation: 2,
      currentGeneration: () => 2,
      onTimedText: rejected,
    });
    await target.fetch(OPAQUE_OCA_URL);
    await settle();
    expect(rejected).not.toHaveBeenCalled();
    withoutBinding.dispose();
  });

  it('returns the original promise immediately, clones later, and installs only once', async () => {
    let resolveResponse!: (value: ProbeResponseLike) => void;
    const originalPromise = new Promise<ProbeResponseLike>((resolve) => {
      resolveResponse = resolve;
    });
    const originalFetch = vi.fn(() => originalPromise);
    const target: FetchTargetLike = { fetch: originalFetch };
    const captured = vi.fn();
    const clone = vi.fn(() => response('WEBVTT\n\n00:00.000 --> 00:01.000\nHello'));
    const liveResponse = response('', { clone });

    const first = installFetchProbe(target, {
      generation: 7,
      currentGeneration: () => 7,
      onTimedText: captured,
    });
    const second = installFetchProbe(target, {
      generation: 7,
      currentGeneration: () => 7,
      onTimedText: captured,
    });
    expect(second).toBe(first);

    const returned = target.fetch(VTT_URL);
    expect(returned).toBe(originalPromise);
    expect(clone).not.toHaveBeenCalled();

    resolveResponse(liveResponse);
    await settle();
    expect(clone).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith({
      type: 'timed-text',
      resourceId: expect.stringMatching(/^tt_/),
      trackId: expect.stringMatching(/^tt_/),
      language: 'en',
      format: 'webvtt',
      body: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello',
    });

    first.dispose();
    expect(target.fetch).toBe(originalFetch);
  });

  it('clones in promise fulfillment before the page immediately consumes the response', async () => {
    let consumed = false;
    const captured = vi.fn();
    const clone = vi.fn(() => {
      if (consumed) throw new Error('body already consumed');
      return response('WEBVTT\n\n00:00.000 --> 00:01.000\nclone');
    });
    const liveResponse = response('', {
      clone,
      text: async () => {
        consumed = true;
        return 'page body';
      },
    });
    const target: FetchTargetLike = {
      fetch: vi.fn(async () => liveResponse),
    };
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: captured,
    });

    const returned = target.fetch(VTT_URL);
    const pageRead = returned.then(async (pageResponse) => {
      expect(clone).toHaveBeenCalledTimes(1);
      return pageResponse.text?.();
    });
    await pageRead;
    await settle();

    expect(captured).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('sniffs the first stream chunk and cancels an unsupported body without reading more', async () => {
    const read = vi
      .fn<() => Promise<{ done: boolean; value?: Uint8Array }>>()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode('<html>not timed text</html>'),
      })
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode('WEBVTT should never be read'),
      });
    const cancel = vi.fn(async () => undefined);
    const cloneBody = response('', {
      body: { getReader: () => ({ read, cancel }) },
    });
    const target: FetchTargetLike = {
      fetch: vi.fn(async () => response('', { clone: () => cloneBody })),
    };
    const captured = vi.fn();
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: captured,
    });

    await target.fetch(VTT_URL);
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(captured).not.toHaveBeenCalled();
    handle.dispose();
  });

  it.each([
    [
      'WebVTT',
      [
        new Uint8Array(),
        new TextEncoder().encode('WEB'),
        new TextEncoder().encode('VTT\n\n00:00.000 --> 00:01.000\nsplit'),
      ],
      'webvtt',
    ],
    [
      'TTML XML declaration',
      [
        new TextEncoder().encode('<?xml ver'),
        new TextEncoder().encode('sion="1.0"?>\n<t'),
        new TextEncoder().encode('t xmlns="http://www.w3.org/ns/ttml"></tt>'),
      ],
      'ttml',
    ],
  ])('accumulates a bounded prefix when a %s signature crosses chunks', async (
    _name,
    chunks,
    expectedFormat,
  ) => {
    let index = 0;
    const read = vi.fn(async () => {
      const value = chunks[index];
      index += 1;
      return value === undefined ? { done: true } : { done: false, value };
    });
    const cancel = vi.fn(async () => undefined);
    const cloneBody = response('', {
      body: { getReader: () => ({ read, cancel }) },
    });
    const target: FetchTargetLike = {
      fetch: vi.fn(async () => response('', { clone: () => cloneBody })),
    };
    const captured = vi.fn();
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: captured,
    });

    await target.fetch(VTT_URL);
    await settle();

    await vi.waitFor(() => {
      expect(captured).toHaveBeenCalledWith(
        expect.objectContaining({ format: expectedFormat }),
      );
    });
    expect(cancel).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('rejects an off-domain final fetch URL before cloning a redirected response', async () => {
    const clone = vi.fn(() => response('WEBVTT\n\nredirected'));
    const target: FetchTargetLike = {
      fetch: vi.fn(async () =>
        response('', {
          url: 'https://evil.example/timedtext/track.vtt',
          clone,
        }),
      ),
    };
    const captured = vi.fn();
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: captured,
    });

    await target.fetch(VTT_URL);
    await settle();
    expect(clone).not.toHaveBeenCalled();
    expect(captured).not.toHaveBeenCalled();
    handle.dispose();
  });

  it.each(['text', 'arrayBuffer'] as const)(
    'refuses an unstreamable %s fallback without a trusted content length',
    async (fallback) => {
      const read = vi.fn(async () =>
        fallback === 'text'
          ? 'WEBVTT\n\nunknown length'
          : new TextEncoder().encode('WEBVTT\n\nunknown length').buffer,
      );
      const cloneBody: ProbeResponseLike = {
        url: VTT_URL,
        headers: headers({ 'content-type': 'text/vtt' }),
        clone() {
          return this;
        },
        ...(fallback === 'text'
          ? { text: read as () => Promise<string> }
          : { arrayBuffer: read as () => Promise<ArrayBuffer> }),
      };
      const target: FetchTargetLike = {
        fetch: vi.fn(async () =>
          response('', {
            headers: headers({ 'content-type': 'text/vtt' }),
            clone: () => cloneBody,
          }),
        ),
      };
      const captured = vi.fn();
      const handle = installFetchProbe(target, {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: captured,
      });

      await target.fetch(VTT_URL);
      await settle();
      expect(read).not.toHaveBeenCalled();
      expect(captured).not.toHaveBeenCalled();
      handle.dispose();
    },
  );

  it('skips media and enforces the actual body bound when content-length is missing', async () => {
    const captured = vi.fn();
    const mediaClone = vi.fn(() => response('WEBVTT'));
    const streamRead = vi
      .fn<() => Promise<{ done: boolean; value?: Uint8Array }>>()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode('WEBVTT\n'),
      })
      .mockResolvedValueOnce({
        done: false,
        value: new Uint8Array(10 * 1024 * 1024),
      });
    const streamCancel = vi.fn(async () => undefined);
    const oversizedClone = vi.fn(() =>
      response('', {
        headers: headers({ 'content-type': 'text/vtt' }),
        body: { getReader: () => ({ read: streamRead, cancel: streamCancel }) },
      }),
    );
    const replies = [
      response('', {
        headers: headers({ 'content-type': 'video/mp4' }),
        clone: mediaClone,
      }),
      response('', {
        headers: headers({ 'content-type': 'text/vtt' }),
        clone: oversizedClone,
      }),
    ];
    const target: FetchTargetLike = {
      fetch: vi.fn(async () => replies.shift() ?? response('')),
    };
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: captured,
    });

    await target.fetch(VTT_URL);
    await target.fetch(VTT_URL);
    await settle();

    expect(mediaClone).not.toHaveBeenCalled();
    expect(oversizedClone).toHaveBeenCalledTimes(1);
    expect(streamRead).toHaveBeenCalledTimes(2);
    expect(streamCancel).toHaveBeenCalledTimes(1);
    expect(captured).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('drops old-generation work and does not overwrite a later fetch owner on dispose', async () => {
    let currentGeneration = 1;
    const captured = vi.fn();
    const target: FetchTargetLike = {
      fetch: vi.fn(async () => response('WEBVTT\n\nold')),
    };
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => currentGeneration,
      onTimedText: captured,
    });
    const replacement = vi.fn(async () => response(''));

    const pending = target.fetch(VTT_URL);
    currentGeneration = 2;
    await pending;
    await settle();
    expect(captured).not.toHaveBeenCalled();

    target.fetch = replacement;
    handle.dispose();
    expect(target.fetch).toBe(replacement);
  });

  it('updates a still-owned fetch patch for a new generation and drops its old request', async () => {
    let resolveOld!: (value: ProbeResponseLike) => void;
    const oldPromise = new Promise<ProbeResponseLike>((resolve) => {
      resolveOld = resolve;
    });
    let call = 0;
    const target: FetchTargetLike = {
      fetch: vi.fn(() => {
        call += 1;
        return call === 1
          ? oldPromise
          : Promise.resolve(response('WEBVTT\n\nnew generation'));
      }),
    };
    let generation = 1;
    const oldCapture = vi.fn();
    const nextCapture = vi.fn();
    const first = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => generation,
      onTimedText: oldCapture,
    });
    const oldRequest = target.fetch(VTT_URL);

    generation = 2;
    const second = installFetchProbe(target, {
      generation: 2,
      currentGeneration: () => generation,
      onTimedText: nextCapture,
    });
    expect(second).toBe(first);
    resolveOld(response('WEBVTT\n\nold generation'));
    await oldRequest;
    await settle();
    expect(oldCapture).not.toHaveBeenCalled();
    expect(nextCapture).not.toHaveBeenCalled();

    await target.fetch(VTT_URL);
    await settle();
    expect(oldCapture).not.toHaveBeenCalled();
    expect(nextCapture).toHaveBeenCalledTimes(1);
    first.dispose();
  });

  it('contains asynchronous clone-read failures', async () => {
    const captured = vi.fn();
    const target: FetchTargetLike = {
      fetch: vi.fn(async () =>
        response('', {
          clone: () =>
            response('', {
              text: async () => {
                throw new Error('clone read failed');
              },
            }),
        }),
      ),
    };
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: captured,
    });

    await target.fetch(VTT_URL);
    await settle();
    expect(captured).not.toHaveBeenCalled();
    handle.dispose();
  });
});

describe('Netflix XHR instrumentation', () => {
  it('sniffs a bounded opaque OCA arraybuffer response used by Cadmium subtitles', async () => {
    class BinaryOcaXhr {
      readonly listeners = new Set<() => void>();
      responseType = 'arraybuffer';
      response = new TextEncoder().encode(
        'WEBVTT\n\n00:00.000 --> 00:01.000\n你好',
      ).buffer;
      responseText = '';
      responseURL = OPAQUE_OCA_URL;
      open(): void {}
      send(): void {}
      addEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.add(listener);
      }
      removeEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.delete(listener);
      }
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/octet-stream' : null;
      }
      dispatchLoad(): void {
        for (const listener of [...this.listeners]) listener();
      }
    }
    const captured = vi.fn();
    const handle = installXhrProbe(BinaryOcaXhr as unknown as XhrConstructorLike, {
      generation: 1,
      currentGeneration: () => 1,
      currentTimedTextBinding: () => ({ titleId: 'title-1', trackId: 'zh-main' }),
      onTimedText: captured,
    });
    const xhr = new BinaryOcaXhr();
    (BinaryOcaXhr.prototype.open as unknown as (
      this: BinaryOcaXhr,
      method: string,
      url: string,
    ) => void).call(xhr, 'GET', OPAQUE_OCA_URL);
    xhr.send();
    xhr.dispatchLoad();
    await settle();

    expect(captured).toHaveBeenCalledWith(expect.objectContaining({
      trackId: 'zh-main',
      format: 'webvtt',
      body: 'WEBVTT\n\n00:00.000 --> 00:01.000\n你好',
    }));
    handle.dispose();
  });

  it('captures an opaque OCA XHR only with the track binding snapshotted at send time', async () => {
    class OcaXhr {
      readonly listeners = new Set<() => void>();
      responseType = '';
      responseText = 'WEBVTT\n\n00:00.000 --> 00:01.000\n你好';
      responseURL = OPAQUE_OCA_URL;
      open(): void {}
      send(): void {}
      addEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.add(listener);
      }
      removeEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.delete(listener);
      }
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/octet-stream' : null;
      }
      dispatchLoad(): void {
        for (const listener of [...this.listeners]) listener();
      }
    }
    let binding: { titleId: string; trackId: string } | undefined = {
      titleId: 'title-1',
      trackId: 'zh-main',
    };
    const captured = vi.fn();
    const handle = installXhrProbe(OcaXhr as unknown as XhrConstructorLike, {
      generation: 1,
      currentGeneration: () => 1,
      currentTimedTextBinding: () => binding,
      onTimedText: captured,
    });
    const xhr = new OcaXhr();
    (OcaXhr.prototype.open as unknown as (
      this: OcaXhr,
      method: string,
      url: string,
    ) => void).call(xhr, 'GET', OPAQUE_OCA_URL);
    xhr.send();
    binding = undefined;
    xhr.dispatchLoad();
    await settle();

    expect(captured).toHaveBeenCalledWith(expect.objectContaining({
      trackId: 'zh-main',
      language: 'und',
      format: 'webvtt',
    }));
    handle.dispose();
  });

  it('keeps metadata off instances, observes after load callbacks, and restores owned methods', async () => {
    const order: string[] = [];
    const captured = vi.fn(() => order.push('probe'));

    class FakeXhr {
      static readonly instances: FakeXhr[] = [];
      readonly listeners = new Map<string, Array<() => void>>();
      responseType = '';
      responseText = 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello';
      responseURL = VTT_URL;

      constructor() {
        FakeXhr.instances.push(this);
      }

      open(_method: string, _url: string): string {
        return 'open-result';
      }

      send(): string {
        return 'send-result';
      }

      addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'text/vtt' : null;
      }

      dispatchLoad(): void {
        for (const listener of this.listeners.get('load') ?? []) listener();
      }
    }

    const originalOpen = FakeXhr.prototype.open;
    const originalSend = FakeXhr.prototype.send;
    const ctor = FakeXhr as unknown as XhrConstructorLike;
    const handle = installXhrProbe(ctor, {
      generation: 3,
      currentGeneration: () => 3,
      onTimedText: captured,
    });
    expect(
      installXhrProbe(ctor, {
        generation: 3,
        currentGeneration: () => 3,
        onTimedText: captured,
      }),
    ).toBe(handle);

    const xhr = new FakeXhr();
    const ownKeysBefore = Object.keys(xhr);
    xhr.addEventListener('load', () => order.push('page'));
    expect(xhr.open('GET', VTT_URL)).toBe('open-result');
    expect(xhr.send()).toBe('send-result');
    expect(Object.keys(xhr)).toEqual(ownKeysBefore);
    xhr.dispatchLoad();
    expect(order).toEqual(['page']);
    await settle();
    expect(order).toEqual(['page', 'probe']);

    handle.dispose();
    expect(FakeXhr.prototype.open).toBe(originalOpen);
    expect(FakeXhr.prototype.send).toBe(originalSend);
  });

  it('does not retain a load listener for an aborted unrelated XHR', () => {
    class UnrelatedXhr {
      readonly listeners = new Map<string, Set<() => void>>();
      responseType = '';
      responseText = '';
      responseURL = '';

      open(_method: string, url: string): void {
        this.responseURL = url;
      }
      send(): void {}
      abort(): void {
        for (const listener of this.listeners.get('abort') ?? []) listener();
      }
      addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
      }
      getResponseHeader(): string | null {
        return null;
      }
    }

    const handle = installXhrProbe(
      UnrelatedXhr as unknown as XhrConstructorLike,
      {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: vi.fn(),
      },
    );
    const xhr = new UnrelatedXhr();
    xhr.open('GET', 'https://www.netflix.com/api/shakti/v1/playback/heartbeat');
    xhr.send();
    xhr.abort();

    expect(xhr.listeners.get('load')?.size ?? 0).toBe(0);
    handle.dispose();
  });

  it('updates generations and removes the stale observer when an XHR is reopened', async () => {
    class ReusedXhr {
      readonly listeners = new Set<() => void>();
      responseType = '';
      responseText = 'WEBVTT\n\nnew request';
      responseURL = VTT_URL;

      open(_method: string, url: string): void {
        this.responseURL = url;
      }

      send(): void {}

      addEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.add(listener);
      }

      removeEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.delete(listener);
      }

      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'text/vtt' : null;
      }

      dispatchLoad(): void {
        for (const listener of [...this.listeners]) listener();
      }
    }

    let generation = 1;
    const oldCapture = vi.fn();
    const nextCapture = vi.fn();
    const ctor = ReusedXhr as unknown as XhrConstructorLike;
    const first = installXhrProbe(ctor, {
      generation: 1,
      currentGeneration: () => generation,
      onTimedText: oldCapture,
    });
    generation = 2;
    const second = installXhrProbe(ctor, {
      generation: 2,
      currentGeneration: () => generation,
      onTimedText: nextCapture,
    });
    expect(second).toBe(first);

    const xhr = new ReusedXhr();
    xhr.open('GET',
      'https://cdn.nflxvideo.net/timedtext/range/0-9/old.vtt?lang=en');
    xhr.send();
    xhr.open('GET',
      'https://cdn.nflxvideo.net/timedtext/range/10-19/new.vtt?lang=en');
    xhr.send();
    expect(xhr.listeners.size).toBe(1);

    xhr.dispatchLoad();
    await settle();
    expect(oldCapture).not.toHaveBeenCalled();
    expect(nextCapture).toHaveBeenCalledTimes(1);
    first.dispose();
    expect(xhr.listeners.size).toBe(0);
  });

  it('rejects an off-domain final XHR response URL', async () => {
    class RedirectedXhr {
      readonly listeners = new Set<() => void>();
      responseType = '';
      responseText = 'WEBVTT\n\nredirected';
      responseURL = 'https://evil.example/timedtext/track.vtt';

      open(): void {}
      send(): void {}
      addEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.add(listener);
      }
      removeEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.delete(listener);
      }
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'text/vtt' : null;
      }
      dispatchLoad(): void {
        for (const listener of [...this.listeners]) listener();
      }
    }

    const captured = vi.fn();
    const handle = installXhrProbe(
      RedirectedXhr as unknown as XhrConstructorLike,
      {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: captured,
      },
    );
    const xhr = new RedirectedXhr();
    (RedirectedXhr.prototype.open as unknown as (
      this: RedirectedXhr,
      method: string,
      url: string,
    ) => void).call(xhr, 'GET', VTT_URL);
    xhr.send();
    xhr.dispatchLoad();
    await settle();
    expect(captured).not.toHaveBeenCalled();
    handle.dispose();
  });
});

describe('conservative catalog extraction', () => {
  it('recognizes synthetic fixtures and unverified presence-only track arrays', () => {
    const complete = extractCatalogObservation({
      kind: 'subtwin-synthetic-catalog-v1',
      titleId: 'title-1',
      complete: true,
      tracks: [{ id: 'en-1', language: 'en', kind: 'subtitle' }],
    });
    expect(complete).toEqual({
      ok: true,
      value: {
        type: 'catalog',
        titleId: 'title-1',
        authority: 'authoritative',
        tracks: [{ id: 'en-1', language: 'en', kind: 'subtitle' }],
      },
    });

    const fragment = extractCatalogObservation({
      kind: 'subtwin-synthetic-track-v1',
      titleId: 'title-1',
      track: { id: 'en-1', language: 'en', kind: 'subtitle' },
    });
    expect(fragment.ok && fragment.value.authority).toBe('provisional');

    const observed = extractCatalogObservation({
      movieId: 123,
      timedtexttracks: [{ language: 'en' }],
    });
    expect(observed).toMatchObject({
      ok: true,
      value: {
        titleId: '123',
        authority: 'provisional',
        tracks: [{ language: 'en', kind: 'subtitle' }],
      },
    });
  });
});
