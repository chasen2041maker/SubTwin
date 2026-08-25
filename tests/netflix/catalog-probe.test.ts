import { describe, expect, it, vi } from 'vitest';

import {
  extractCatalogObservation,
  installFetchProbe,
  installJsonParseProbe,
  installXhrProbe,
  type FetchTargetLike,
  type ProbeResponseLike,
  type JsonParseTargetLike,
  type XhrConstructorLike,
} from '../../src/netflix/probe';

function headers(values: Readonly<Record<string, string>>) {
  return {
    get(name: string): string | null {
      const key = Object.keys(values).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
      );
      return key === undefined ? null : (values[key] ?? null);
    },
  };
}

function catalogFixture(): unknown {
  return {
    result: {
      movieId: 8_012_345,
      complete: true,
      timedtexttracks: [
        {
          new_track_id: 'en-main',
          bcp47: 'en-US',
          rawTrackType: 'SUBTITLES',
          downloadables: { webvtt: { urls: { a: 'signed-secret' } } },
        },
        {
          trackId: 'zh-main',
          languageCode: 'zh_cn',
          trackType: 'CLOSEDCAPTIONS',
        },
      ],
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('conservative Netflix catalog observation', () => {
  it('enumerates explicit timed-text arrays as presence-only sanitized tracks', () => {
    const result = extractCatalogObservation(catalogFixture(), {
      allowSyntheticAuthoritative: false,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        type: 'catalog',
        titleId: '8012345',
        authority: 'provisional',
        tracks: [
          { id: 'en-main', language: 'en-US', kind: 'subtitle' },
          { id: 'zh-main', language: 'zh-cn', kind: 'closed-caption' },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('signed-secret');
    expect(JSON.stringify(result)).not.toContain('downloadables');
  });

  it('never treats an unverified complete flag or synthetic marker as authoritative in network mode', () => {
    const observed = extractCatalogObservation(catalogFixture(), {
      allowSyntheticAuthoritative: false,
    });
    expect(observed.ok && observed.value.authority).toBe('provisional');

    const synthetic = extractCatalogObservation(
      {
        kind: 'subtwin-synthetic-catalog-v1',
        titleId: 'title-1',
        complete: true,
        tracks: [{ id: 'en', language: 'en', kind: 'subtitle' }],
      },
      { allowSyntheticAuthoritative: false },
    );
    expect(synthetic.ok).toBe(false);
  });

  it('observes decrypted manifest JSON without changing JSON.parse semantics', async () => {
    const originalParse = vi.fn((...args: Parameters<typeof JSON.parse>) =>
      JSON.parse(...args));
    const target: JsonParseTargetLike = { parse: originalParse };
    const onCatalog = vi.fn();
    const onCatalogMetadata = vi.fn();
    const onDiagnostic = vi.fn();
    const handle = installJsonParseProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: vi.fn(),
      onCatalog,
      onCatalogMetadata,
      onDiagnostic,
    });
    const manifest = JSON.stringify(catalogFixture());
    const reviver = vi.fn((_key: string, value: unknown) => value);

    const parsed = target.parse(manifest, reviver);
    const unrelated = target.parse('{"event":"heartbeat"}');
    await settle();

    expect(parsed).toEqual(catalogFixture());
    expect(unrelated).toEqual({ event: 'heartbeat' });
    expect(reviver).toHaveBeenCalled();
    expect(onCatalog).toHaveBeenCalledOnce();
    expect(onCatalog).toHaveBeenCalledWith(expect.objectContaining({
      authority: 'provisional',
      titleId: '8012345',
    }));
    expect(onCatalogMetadata).toHaveBeenCalledOnce();
    expect(onCatalogMetadata).toHaveBeenCalledWith(parsed);
    expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
      'metadata_json_parsed',
      'metadata_catalog_recognized',
    ]);
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('signed-secret');

    handle.dispose();
    expect(target.parse).toBe(originalParse);
    expect(() => target.parse('{')).toThrow(SyntaxError);
  });

  it('observes the explicit Netflix data.result manifest wrapper', async () => {
    const target: JsonParseTargetLike = { parse: JSON.parse };
    const onCatalogMetadata = vi.fn();
    const handle = installJsonParseProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: vi.fn(),
      onCatalogMetadata,
    });
    const wrapped = { data: catalogFixture() };

    const parsed = target.parse(JSON.stringify(wrapped));
    await settle();

    expect(parsed).toEqual(wrapped);
    expect(onCatalogMetadata).toHaveBeenCalledOnce();
    expect(onCatalogMetadata).toHaveBeenCalledWith(parsed);
    handle.dispose();
  });

  it('observes a bounded Netflix JSON manifest asynchronously through fetch', async () => {
    const body = JSON.stringify(catalogFixture());
    const response: ProbeResponseLike = {
      url: 'https://www.netflix.com/api/shakti/v1/playback/manifest',
      headers: headers({
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(body).byteLength),
      }),
      clone: () => response,
      text: vi.fn(async () => body),
    };
    const originalPromise = Promise.resolve(response);
    const target: FetchTargetLike = {
      fetch: vi.fn(() => originalPromise),
    };
    const onCatalog = vi.fn();
    const onCatalogMetadata = vi.fn();
    const onDiagnostic = vi.fn();
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: vi.fn(),
      onCatalog,
      onCatalogMetadata,
      onDiagnostic,
    });

    expect(
      target.fetch('https://www.netflix.com/api/shakti/v1/playback/manifest'),
    ).toBe(originalPromise);
    await settle();

    expect(onCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'catalog',
        authority: 'provisional',
        tracks: expect.arrayContaining([
          expect.objectContaining({ id: 'en-main', language: 'en-US' }),
          expect.objectContaining({ id: 'zh-main', language: 'zh-cn' }),
        ]),
      }),
    );
    expect(onCatalogMetadata).toHaveBeenCalledWith(catalogFixture());
    expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
      'metadata_candidate_observed',
      'metadata_response_accepted',
      'metadata_json_parsed',
      'metadata_catalog_recognized',
    ]);
    handle.dispose();
  });

  it('observes the licensedmanifest playback endpoint used by Netflix Cadmium', async () => {
    const body = JSON.stringify(catalogFixture());
    const endpoint =
      'https://www.netflix.com/msl/playapi/cadmium/licensedmanifest/1?client=web';
    const response: ProbeResponseLike = {
      url: endpoint,
      headers: headers({
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(body).byteLength),
      }),
      clone: () => response,
      text: vi.fn(async () => body),
    };
    const target: FetchTargetLike = { fetch: vi.fn(async () => response) };
    const onCatalog = vi.fn();
    const onCatalogMetadata = vi.fn();
    const onDiagnostic = vi.fn();
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: vi.fn(),
      onCatalog,
      onCatalogMetadata,
      onDiagnostic,
    });

    await target.fetch(endpoint);
    await settle();

    expect(onCatalog).toHaveBeenCalledOnce();
    expect(onCatalogMetadata).toHaveBeenCalledWith(catalogFixture());
    expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
      'metadata_candidate_observed',
      'metadata_response_accepted',
      'metadata_json_parsed',
      'metadata_catalog_recognized',
    ]);
    handle.dispose();
  });

  it('ignores unrelated JSON endpoints that merely live under /api/shakti', async () => {
    const body = JSON.stringify({ event: 'playback-heartbeat' });
    const clone = vi.fn();
    const response: ProbeResponseLike = {
      url: 'https://www.netflix.com/api/shakti/v1/logblob',
      headers: headers({
        'content-type': 'application/json',
        'content-length': String(body.length),
      }),
      clone: () => {
        clone();
        return response;
      },
      text: vi.fn(async () => body),
    };
    const target: FetchTargetLike = { fetch: vi.fn(async () => response) };
    const onDiagnostic = vi.fn();
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: vi.fn(),
      onDiagnostic,
    });

    await target.fetch('https://www.netflix.com/api/shakti/v1/logblob');
    await settle();

    expect(onDiagnostic).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('ignores playback and metadata path lookalikes that are not manifests', async () => {
    for (const pathname of [
      '/api/playback-heartbeat',
      '/api/metadata-events',
      '/api/manifestation',
      '/msl/playapi/cadmium/notlicensedmanifest/1',
    ]) {
      const body = JSON.stringify({ event: 'not-a-manifest' });
      const response: ProbeResponseLike = {
        url: `https://www.netflix.com${pathname}`,
        headers: headers({
          'content-type': 'application/json',
          'content-length': String(body.length),
        }),
        clone: () => response,
        text: vi.fn(async () => body),
      };
      const target: FetchTargetLike = { fetch: vi.fn(async () => response) };
      const onDiagnostic = vi.fn();
      const handle = installFetchProbe(target, {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: vi.fn(),
        onDiagnostic,
      });

      await target.fetch(`https://www.netflix.com${pathname}`);
      await settle();

      expect(onDiagnostic).not.toHaveBeenCalled();
      handle.dispose();
    }
  });

  it('observes the same sanitized provisional catalog through XHR', async () => {
    const body = JSON.stringify(catalogFixture());
    class FakeXhr {
      readonly listeners = new Set<() => void>();
      responseType = '';
      responseText = body;
      responseURL = 'https://www.netflix.com/api/shakti/v1/playback/manifest';

      open(..._args: unknown[]): void {}
      send(..._args: unknown[]): void {}
      addEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.add(listener);
      }
      removeEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.delete(listener);
      }
      getResponseHeader(name: string): string | null {
        if (name.toLowerCase() === 'content-type') return 'application/json';
        if (name.toLowerCase() === 'content-length') {
          return String(new TextEncoder().encode(body).byteLength);
        }
        return null;
      }
      dispatchLoad(): void {
        for (const listener of [...this.listeners]) listener();
      }
    }

    const onCatalog = vi.fn();
    const onDiagnostic = vi.fn();
    const handle = installXhrProbe(
      FakeXhr as unknown as XhrConstructorLike,
      {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: vi.fn(),
        onCatalog,
        onDiagnostic,
      },
    );
    const xhr = new FakeXhr();
    xhr.open(
      'GET',
      'https://www.netflix.com/api/shakti/v1/playback/manifest',
    );
    xhr.send();
    xhr.dispatchLoad();
    await settle();

    expect(onCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: 'provisional',
        tracks: expect.arrayContaining([
          expect.objectContaining({ id: 'en-main' }),
          expect.objectContaining({ id: 'zh-main' }),
        ]),
      }),
    );
    expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
      'metadata_candidate_observed',
      'metadata_response_accepted',
      'metadata_json_parsed',
      'metadata_catalog_recognized',
    ]);
    handle.dispose();
  });

  it('observes an already parsed JSON XHR response without reading responseText', async () => {
    class JsonXhr {
      readonly listeners = new Set<() => void>();
      responseType = 'json';
      response = catalogFixture();
      responseURL = 'https://www.netflix.com/api/shakti/v1/playback/manifest';

      get responseText(): string {
        throw new Error('responseText must not be read for responseType=json');
      }

      open(..._args: unknown[]): void {}
      send(..._args: unknown[]): void {}
      addEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.add(listener);
      }
      removeEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.delete(listener);
      }
      getResponseHeader(): string | null {
        return 'application/json';
      }
      dispatchLoad(): void {
        for (const listener of [...this.listeners]) listener();
      }
    }
    const onCatalog = vi.fn();
    const onCatalogMetadata = vi.fn();
    const onDiagnostic = vi.fn();
    const handle = installXhrProbe(
      JsonXhr as unknown as XhrConstructorLike,
      {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: vi.fn(),
        onCatalog,
        onCatalogMetadata,
        onDiagnostic,
      },
    );
    const xhr = new JsonXhr();
    xhr.open('GET', 'https://www.netflix.com/api/shakti/v1/playback/manifest');
    xhr.send();
    xhr.dispatchLoad();
    await settle();

    expect(onCatalog).toHaveBeenCalledWith(expect.objectContaining({
      authority: 'provisional',
      titleId: '8012345',
    }));
    expect(onCatalogMetadata).toHaveBeenCalledWith(xhr.response);
    expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
      'metadata_candidate_observed',
      'metadata_response_accepted',
      'metadata_json_parsed',
      'metadata_catalog_recognized',
    ]);
    handle.dispose();
  });

  it('reports invalid XHR metadata JSON without exposing its body', async () => {
    const body = '{private-invalid-json';
    class InvalidJsonXhr {
      readonly listeners = new Set<() => void>();
      responseType = '';
      responseText = body;
      responseURL = 'https://www.netflix.com/api/shakti/v1/playback/manifest';

      open(..._args: unknown[]): void {}
      send(..._args: unknown[]): void {}
      addEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.add(listener);
      }
      removeEventListener(type: string, listener: () => void): void {
        if (type === 'load') this.listeners.delete(listener);
      }
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type'
          ? 'application/json'
          : null;
      }
      dispatchLoad(): void {
        for (const listener of [...this.listeners]) listener();
      }
    }

    const onDiagnostic = vi.fn();
    const handle = installXhrProbe(
      InvalidJsonXhr as unknown as XhrConstructorLike,
      {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: vi.fn(),
        onDiagnostic,
      },
    );
    const xhr = new InvalidJsonXhr();
    xhr.open('GET', 'https://www.netflix.com/api/shakti/v1/playback/manifest');
    xhr.send();
    xhr.dispatchLoad();
    await settle();

    expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
      'metadata_candidate_observed',
      'metadata_response_accepted',
      'metadata_json_invalid',
    ]);
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain(body);
    handle.dispose();
  });

  it('reports XHR metadata read, size, and content-type failures as codes only', async () => {
    const cases = [
      {
        code: 'metadata_body_read_failed',
        contentType: 'application/json',
        contentLength: null,
        responseText: (): string => { throw new Error('private XHR failure'); },
      },
      {
        code: 'metadata_body_too_large',
        contentType: 'application/json',
        contentLength: '5',
        responseText: (): string => 'never-read',
      },
      {
        code: 'metadata_body_unsupported',
        contentType: 'text/plain',
        contentLength: null,
        responseText: (): string => 'x',
      },
    ] as const;

    for (const testCase of cases) {
      class FailedMetadataXhr {
        readonly listeners = new Set<() => void>();
        responseType = '';
        responseURL = 'https://www.netflix.com/api/shakti/v1/playback/manifest';

        get responseText(): string {
          return testCase.responseText();
        }
        open(..._args: unknown[]): void {}
        send(..._args: unknown[]): void {}
        addEventListener(type: string, listener: () => void): void {
          if (type === 'load') this.listeners.add(listener);
        }
        removeEventListener(type: string, listener: () => void): void {
          if (type === 'load') this.listeners.delete(listener);
        }
        getResponseHeader(name: string): string | null {
          if (name.toLowerCase() === 'content-type') return testCase.contentType;
          if (name.toLowerCase() === 'content-length') {
            return testCase.contentLength;
          }
          return null;
        }
        dispatchLoad(): void {
          for (const listener of [...this.listeners]) listener();
        }
      }

      const onDiagnostic = vi.fn();
      const handle = installXhrProbe(
        FailedMetadataXhr as unknown as XhrConstructorLike,
        {
          generation: 1,
          currentGeneration: () => 1,
          onTimedText: vi.fn(),
          onDiagnostic,
          maxBytes: 4,
        },
      );
      const xhr = new FailedMetadataXhr();
      xhr.open('GET', 'https://www.netflix.com/api/shakti/v1/playback/manifest');
      xhr.send();
      xhr.dispatchLoad();
      await settle();

      expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
        'metadata_candidate_observed',
        testCase.code,
      ]);
      expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('private');
      handle.dispose();
    }
  });

  it('times out and cancels only a stalled cloned metadata response branch', async () => {
    const cancel = vi.fn(async () => undefined);
    const response: ProbeResponseLike = {
      url: 'https://www.netflix.com/api/shakti/v1/playback/manifest',
      headers: headers({ 'content-type': 'application/json' }),
      clone: () => response,
      body: {
        getReader: () => ({
          read: () => new Promise(() => undefined),
          cancel,
        }),
      },
    };
    const target: FetchTargetLike = {
      fetch: vi.fn(async () => response),
    };
    const onDiagnostic = vi.fn();
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: vi.fn(),
      onDiagnostic,
      metadataReadTimeoutMs: 5,
    });

    await target.fetch('https://www.netflix.com/api/shakti/v1/playback/manifest');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
      'metadata_candidate_observed',
      'metadata_response_accepted',
      'metadata_body_timeout',
    ]);
    expect(cancel).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it('reports a metadata timeout even when clone cancellation never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response: ProbeResponseLike = {
      url: 'https://www.netflix.com/api/shakti/v1/playback/manifest',
      headers: headers({ 'content-type': 'application/json' }),
      clone: () => response,
      body: {
        getReader: () => ({
          read: () => new Promise(() => undefined),
          cancel,
        }),
      },
    };
    const target: FetchTargetLike = {
      fetch: vi.fn(async () => response),
    };
    const onDiagnostic = vi.fn();
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: vi.fn(),
      onDiagnostic,
      metadataReadTimeoutMs: 5,
    });

    await target.fetch('https://www.netflix.com/api/shakti/v1/playback/manifest');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
      'metadata_candidate_observed',
      'metadata_response_accepted',
      'metadata_body_timeout',
    ]);
    expect(cancel).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it('uses one total timeout budget across metadata stream chunks', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => undefined);
      let reads = 0;
      const response: ProbeResponseLike = {
        url: 'https://www.netflix.com/api/shakti/v1/playback/manifest',
        headers: headers({ 'content-type': 'application/json' }),
        clone: () => response,
        body: {
          getReader: () => ({
            read: () => new Promise((resolve) => {
              reads += 1;
              globalThis.setTimeout(() => {
                resolve({
                  done: false,
                  value: new Uint8Array([0x7b]),
                });
              }, 4);
            }),
            cancel,
          }),
        },
      };
      const target: FetchTargetLike = {
        fetch: vi.fn(async () => response),
      };
      const onDiagnostic = vi.fn();
      const handle = installFetchProbe(target, {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: vi.fn(),
        onDiagnostic,
        metadataReadTimeoutMs: 5,
      });

      await target.fetch('https://www.netflix.com/api/shakti/v1/playback/manifest');
      await vi.advanceTimersByTimeAsync(6);

      expect(reads).toBe(2);
      expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
        'metadata_candidate_observed',
        'metadata_response_accepted',
        'metadata_body_timeout',
      ]);
      expect(cancel).toHaveBeenCalledOnce();
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports invalid bounded metadata JSON without exposing its body', async () => {
    const body = '{not-json';
    const response: ProbeResponseLike = {
      url: 'https://www.netflix.com/api/shakti/v1/playback/manifest',
      headers: headers({
        'content-type': 'application/json',
        'content-length': String(body.length),
      }),
      clone: () => response,
      text: vi.fn(async () => body),
    };
    const target: FetchTargetLike = { fetch: vi.fn(async () => response) };
    const onDiagnostic = vi.fn();
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: vi.fn(),
      onDiagnostic,
    });

    await target.fetch('https://www.netflix.com/api/shakti/v1/playback/manifest');
    await settle();

    expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
      'metadata_candidate_observed',
      'metadata_response_accepted',
      'metadata_json_invalid',
    ]);
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain(body);
    handle.dispose();
  });

  it('reports bounded metadata body failures as codes only', async () => {
    const cases: Array<{
      readonly code:
        | 'metadata_body_read_failed'
        | 'metadata_body_too_large'
        | 'metadata_body_unsupported';
      readonly create: () => ProbeResponseLike;
      readonly maxBytes?: number;
    }> = [
      {
        code: 'metadata_body_read_failed',
        create: () => {
          let response: ProbeResponseLike;
          response = {
            url: 'https://www.netflix.com/api/shakti/v1/playback/manifest',
            headers: headers({ 'content-type': 'application/json' }),
            clone: () => response,
            body: {
              getReader: () => ({
                read: async () => { throw new Error('private body failure'); },
              }),
            },
          };
          return response;
        },
      },
      {
        code: 'metadata_body_too_large',
        maxBytes: 4,
        create: () => {
          let readCount = 0;
          let response: ProbeResponseLike;
          response = {
            url: 'https://www.netflix.com/api/shakti/v1/playback/manifest',
            headers: headers({ 'content-type': 'application/json' }),
            clone: () => response,
            body: {
              getReader: () => ({
                read: async () => readCount++ === 0
                  ? { done: false, value: new Uint8Array(5) }
                  : { done: true },
              }),
            },
          };
          return response;
        },
      },
      {
        code: 'metadata_body_unsupported',
        create: () => {
          let response: ProbeResponseLike;
          response = {
            url: 'https://www.netflix.com/api/shakti/v1/playback/manifest',
            headers: headers({
              'content-type': 'application/json',
              'content-length': '2',
            }),
            clone: () => response,
          };
          return response;
        },
      },
    ];

    for (const testCase of cases) {
      const response = testCase.create();
      const target: FetchTargetLike = { fetch: vi.fn(async () => response) };
      const onDiagnostic = vi.fn();
      const handle = installFetchProbe(target, {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: vi.fn(),
        onDiagnostic,
        ...(testCase.maxBytes === undefined
          ? {}
          : { maxBytes: testCase.maxBytes }),
      });

      await target.fetch('https://www.netflix.com/api/shakti/v1/playback/manifest');
      await settle();
      expect(onDiagnostic.mock.calls.map(([code]) => code)).toEqual([
        'metadata_candidate_observed',
        'metadata_response_accepted',
        testCase.code,
      ]);
      expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('private');
      handle.dispose();
    }
  });
});
