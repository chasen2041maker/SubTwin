import { describe, expect, it, vi } from 'vitest';

import {
  extractCatalogObservation,
  installFetchProbe,
  installXhrProbe,
  type FetchTargetLike,
  type ProbeResponseLike,
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
    const handle = installFetchProbe(target, {
      generation: 1,
      currentGeneration: () => 1,
      onTimedText: vi.fn(),
      onCatalog,
      onCatalogMetadata,
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
    handle.dispose();
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
    const handle = installXhrProbe(
      FakeXhr as unknown as XhrConstructorLike,
      {
        generation: 1,
        currentGeneration: () => 1,
        onTimedText: vi.fn(),
        onCatalog,
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
    handle.dispose();
  });
});
