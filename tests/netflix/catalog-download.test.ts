import { describe, expect, it, vi } from 'vitest';

import {
  downloadNetflixEmbeddedLanguageTimedText,
  downloadNetflixTimedText,
  extractNetflixCatalogDownloadResources,
  type NetflixCatalogDownloadError,
  type NetflixCatalogDownloadResource,
  type NetflixTimedTextFetch,
  type NetflixTimedTextResponseLike,
} from '../../src/netflix/catalog-download';
import { canonicalizeNetflixTimedTextResource } from '../../src/netflix/probe';

const EN_URL =
  'https://ipv4-c001-lax001.nflxvideo.net/timedtext/en/track.vtt?trackid=en-main&token=signed-secret';
const EN_ALT_URL =
  'https://assets.nflximg.net/subtitles/en/alternate.vtt?trackid=en-alt&sig=secret';
const ZH_URL =
  'https://cdn.nflxso.net/timed-text/zh/track.ttml?trackid=zh-main&signature=signed-secret';
const OCA_URL =
  'https://ipv4-c001-lax001.oca.nflxvideo.net/?o=1&v=42&e=1999999999&t=signed-secret';

function expectErrorCode<T>(
  result: { readonly ok: boolean; readonly error?: NetflixCatalogDownloadError },
  code: NetflixCatalogDownloadError['code'],
): void {
  expect(result.ok).toBe(false);
  if ('error' in result && result.error !== undefined) {
    expect(result.error).toMatchObject({ code, retryable: false });
    expect(JSON.stringify(result.error)).not.toMatch(
      /signed-secret|token=|signature=|nflxvideo/iu,
    );
  }
}

function extractFixture(): unknown {
  return {
    movieId: 8_012_345,
    result: {
      playback: {
        timedtexttracks: [
          {
            new_track_id: 'en-main',
            bcp47: 'en-US',
            rawTrackType: 'SUBTITLES',
            downloadables: {
              webvtt: { downloadUrls: { primary: EN_URL } },
            },
            accountToken: 'must-not-copy',
          },
          {
            trackId: 'zh-main',
            languageCode: 'zh_cn',
            trackType: 'CLOSEDCAPTIONS',
            ttDownloadables: {
              dfxp: { urls: [ZH_URL] },
            },
          },
          {
            trackId: 'fr-main',
            bcp47Tag: 'fr-FR',
            kind: 'subtitle',
            downloadables: { webvtt: { urls: [EN_ALT_URL] } },
          },
          {
            trackId: 'forced-en',
            bcp47: 'en-US',
            rawTrackType: 'FORCED_NARRATIVE',
            downloadables: { webvtt: { urls: [EN_ALT_URL] } },
          },
          {
            isNoneTrack: true,
            downloadables: { webvtt: { urls: [EN_ALT_URL] } },
          },
        ],
      },
    },
  };
}

function resource(overrides: Partial<NetflixCatalogDownloadResource> = {}) {
  const extracted = extractNetflixCatalogDownloadResources(extractFixture());
  if (!extracted.ok) throw new Error('fixture must be extractable');
  const first = extracted.value[0];
  if (first === undefined) throw new Error('fixture must include English');
  return { ...first, ...overrides };
}

function ocaResource(): NetflixCatalogDownloadResource {
  const extracted = extractNetflixCatalogDownloadResources({
    movieId: 8_012_345,
    timedtexttracks: [{
      new_track_id: 'T:2:0;1;en;0;0;0;',
      bcp47: 'en',
      rawTrackType: 'SUBTITLES',
      ttDownloadables: {
        'webvtt-lssdh-ios8': { downloadUrls: { primary: OCA_URL } },
      },
    }],
  });
  if (!extracted.ok || extracted.value[0] === undefined) {
    throw new Error('OCA fixture must be extractable');
  }
  return extracted.value[0];
}

function withResponseUrl<T extends NetflixTimedTextResponseLike>(
  response: T,
  url = EN_URL,
): T {
  Object.defineProperty(response, 'url', { configurable: true, value: url });
  return response;
}

describe('Netflix catalog download resource extraction', () => {
  it('accepts a query-only OCA subtitle URL only from verified catalog metadata', () => {
    const result = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      timedtexttracks: [{
        id: 'legacy-resource-object-id',
        new_track_id: 'T:2:0;1;en;0;0;0;',
        bcp47: 'en',
        rawTrackType: 'SUBTITLES',
        downloadableIds: { 'webvtt-lssdh-ios8': 1_628_761_434 },
        ttDownloadables: {
          'webvtt-lssdh-ios8': { downloadUrls: { primary: OCA_URL } },
        },
      }],
    });

    expect(canonicalizeNetflixTimedTextResource(OCA_URL).ok).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([expect.objectContaining({
      url: OCA_URL,
      titleId: '8012345',
      resourceId: expect.stringMatching(/^tt_[a-f0-9]{16}$/u),
      trackId: expect.stringMatching(/^track_[a-f0-9]{16}$/u),
      language: 'en',
      kind: 'subtitle',
    })]);
  });

  it('rejects a query-only root URL outside Netflix OCA hosts', () => {
    const result = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      timedtexttracks: [{
        new_track_id: 'T:2:0;1;en;0;0;0;',
        bcp47: 'en',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          webvtt: {
            downloadUrls: {
              primary: 'https://ipv4-c001-lax001.nflxvideo.net/?o=1&v=42&e=1999999999&t=signed',
            },
          },
        },
      }],
    });

    expect(result).toEqual({ ok: true, value: [] });
  });

  it('rejects an OCA catalog URL with a duplicate object identity', () => {
    const result = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      timedtexttracks: [{
        new_track_id: 'T:2:0;1;en;0;0;0;',
        bcp47: 'en',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          webvtt: {
            downloadUrls: {
              primary: 'https://ipv4-c001-lax001.oca.nflxvideo.net/?o=1&o=1&v=42&e=1999999999&t=signed',
            },
          },
        },
      }],
    });

    expect(result).toEqual({ ok: true, value: [] });
  });

  it('keeps distinct OCA text-profile alternatives and prefers WebVTT deterministically', () => {
    const dfxpUrl =
      'https://ipv4-c001-lax001.oca.nflxvideo.net/?o=1&v=41&e=1999999999&t=dfxp-secret';
    const webvttUrl =
      'https://ipv4-c002-lax001.oca.nflxvideo.net/?o=1&v=42&e=1999999999&t=vtt-secret';
    const result = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      timedtexttracks: [{
        new_track_id: 'T:2:0;1;en;0;0;0;',
        bcp47: 'en',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          'dfxp-ls-sdh': { downloadUrls: { primary: dfxpUrl } },
          'webvtt-lssdh-ios8': { downloadUrls: { primary: webvttUrl } },
        },
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(({ url }) => url)).toEqual([webvttUrl, dfxpUrl]);
    expect(new Set(result.value.map(({ resourceId }) => resourceId)).size).toBe(2);
  });

  it('retains at most three text profiles per track in format priority order', () => {
    const urls = {
      other: 'https://ipv4-c004-lax001.oca.nflxvideo.net/?o=1&v=44&e=1999999999&t=other',
      dfxp: 'https://ipv4-c003-lax001.oca.nflxvideo.net/?o=1&v=43&e=1999999999&t=dfxp',
      imsc: 'https://ipv4-c002-lax001.oca.nflxvideo.net/?o=1&v=42&e=1999999999&t=imsc',
      webvtt: 'https://ipv4-c001-lax001.oca.nflxvideo.net/?o=1&v=41&e=1999999999&t=webvtt',
    } as const;
    const result = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      timedtexttracks: [{
        new_track_id: 'T:2:0;1;en;0;0;0;',
        bcp47: 'en',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          simple: { downloadUrls: { primary: urls.other } },
          'dfxp-ls-sdh': { downloadUrls: { primary: urls.dfxp } },
          'imsc1.1': { downloadUrls: { primary: urls.imsc } },
          'webvtt-lssdh-ios8': { downloadUrls: { primary: urls.webvtt } },
        },
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(({ url }) => url)).toEqual([
      urls.webvtt,
      urls.imsc,
      urls.dfxp,
    ]);
  });

  it('rejects image subtitle profiles while retaining text profiles', () => {
    const imageUrl =
      'https://ipv4-c001-lax001.oca.nflxvideo.net/?o=1&v=41&e=1999999999&t=image';
    const textUrl =
      'https://ipv4-c002-lax001.oca.nflxvideo.net/?o=1&v=42&e=1999999999&t=text';
    const result = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      timedtexttracks: [{
        new_track_id: 'T:2:0;1;en;0;0;0;',
        bcp47: 'en',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          'nflx-cmisc-png': { downloadUrls: { primary: imageUrl } },
          webvtt: { downloadUrls: { primary: textUrl } },
        },
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(({ url }) => url)).toEqual([textUrl]);
  });

  it('finds the English and Simplified Chinese downloadable resources in the fixture', () => {
    const result = extractNetflixCatalogDownloadResources(extractFixture());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        url: EN_URL,
        titleId: '8012345',
        resourceId: expect.stringMatching(/^tt_[a-f0-9]{16}$/u),
        trackId: 'en-main',
        language: 'en-US',
        kind: 'subtitle',
      },
      {
        url: ZH_URL,
        titleId: '8012345',
        resourceId: expect.stringMatching(/^tt_[a-f0-9]{16}$/u),
        trackId: 'zh-main',
        language: 'zh-CN',
        kind: 'closed-caption',
      },
    ]);
    expect(JSON.stringify(result.value)).not.toContain('must-not-copy');
  });

  it('supports URL map keys and keeps a deterministic resource for every English track', () => {
    const metadata = {
      titleId: 'title-2',
      textTracks: [
        {
          trackId: 'z-English',
          language: 'en-GB',
          kind: 'SUBTITLE',
          downloadables: { webvtt: { urls: [EN_URL] } },
        },
        {
          trackId: 'a-English',
          language: 'en-US',
          kind: 'SUBTITLE',
          ttDownloadables: {
            webvtt: { downloadUrls: { [EN_ALT_URL]: true } },
          },
        },
        {
          trackId: 'zh-hant',
          language: 'zh-Hant',
          kind: 'SUBTITLE',
          downloadables: { webvtt: { urls: [ZH_URL] } },
        },
      ],
    };

    const result = extractNetflixCatalogDownloadResources(metadata);

    expect(result.ok && result.value).toEqual([
      expect.objectContaining({
        url: EN_ALT_URL,
        titleId: 'title-2',
        trackId: 'a-English',
        language: 'en-US',
      }),
      expect.objectContaining({
        url: EN_URL,
        titleId: 'title-2',
        trackId: 'z-English',
        language: 'en-GB',
      }),
    ]);
  });

  it('bounds retained resources to eight tracks per category independently of profiles', () => {
    const result = extractNetflixCatalogDownloadResources({
      titleId: 'bounded-title',
      textTracks: Array.from({ length: 10 }, (_, index) => ({
        trackId: `en-${index}`,
        language: 'en-US',
        kind: 'SUBTITLE',
        downloadables: {
          webvtt: {
            urls: [
              `https://ipv4-c001-lax001.nflxvideo.net/timedtext/en/track-${index}.vtt?trackid=en-${index}`,
            ],
          },
          dfxp: {
            urls: [
              `https://ipv4-c001-lax001.nflxvideo.net/timedtext/en/track-${index}.ttml?trackid=en-${index}`,
            ],
          },
        },
      })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(16);
    expect(new Set(result.value.map(({ trackId }) => trackId)).size).toBe(8);
  });

  it('ignores non-Netflix URLs and never touches unrelated malicious getters', () => {
    let reads = 0;
    const track = {
      trackId: 'en',
      bcp47: 'en-US',
      rawTrackType: 'SUBTITLES',
      downloadables: {
        webvtt: {
          urls: ['https://evil.example/timedtext/stolen.vtt?token=signed-secret'],
        },
      },
    };
    Object.defineProperty(track, 'secrets', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('signed-secret');
      },
    });

    expect(extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      subtitletracks: [track],
    })).toEqual({
      ok: true,
      value: [],
    });
    expect(reads).toBe(0);
  });

  it('returns typed failures for malformed target tracks and bounded traversal overflow', () => {
    const malformed = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      subtitletracks: [
        {
          trackId: '../English',
          bcp47: 'en-US',
          rawTrackType: 'AUDIO',
          downloadables: { webvtt: { urls: [EN_URL] } },
        },
      ],
    });
    expectErrorCode(malformed, 'netflix_catalog_metadata_invalid');

    const tooMany = extractNetflixCatalogDownloadResources({
      timedtexttracks: Array.from({ length: 257 }, () => ({})),
    });
    expectErrorCode(tooMany, 'netflix_catalog_metadata_too_large');
  });

  it('requires a sanitized metadata title identity and never carries the raw unsafe ID', () => {
    const missing = extractNetflixCatalogDownloadResources({
      subtitletracks: (extractFixture() as { result: { playback: { timedtexttracks: unknown[] } } })
        .result.playback.timedtexttracks,
    });
    expectErrorCode(missing, 'netflix_catalog_metadata_invalid');

    const unsafe = extractFixture() as Record<string, unknown>;
    unsafe.movieId = 'unsafe/movie/id?account=signed-secret';
    const result = extractNetflixCatalogDownloadResources(unsafe);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveLength(0);
    expect(result.value.every(({ titleId }) => /^title-[a-f0-9]{16}$/u.test(titleId)))
      .toBe(true);
    expect(result.value.map(({ titleId }) => titleId).join('|'))
      .not.toContain('signed-secret');
  });
});

describe('Netflix timed-text catalog download', () => {
  it('re-fetches a performance-observed OCA TTML and derives only its root language', async () => {
    const body = '<?xml version="1.0"?><tt xml:lang="zh-Hans" xmlns="http://www.w3.org/ns/ttml"><body /></tt>';
    const fetcher = vi.fn(async () => ({
      ok: true,
      url: OCA_URL,
      headers: new Headers({
        'content-length': String(new TextEncoder().encode(body).byteLength),
        'content-type': 'text/xml',
      }),
      body: null,
      text: async () => body,
    })) as NetflixTimedTextFetch;

    const result = await downloadNetflixEmbeddedLanguageTimedText(fetcher, OCA_URL);

    expect(result).toEqual({
      ok: true,
      value: {
        type: 'timed-text',
        resourceId: expect.stringMatching(/^tt_[a-f0-9]{16}$/u),
        trackId: expect.stringMatching(/^oca_[a-f0-9]{16}$/u),
        language: 'zh-Hans',
        format: 'ttml',
        body,
      },
    });
    expect(fetcher).toHaveBeenCalledWith(OCA_URL, expect.objectContaining({
      credentials: 'omit',
      method: 'GET',
    }));
  });

  it('downloads a bounded WEBVTT body from an approved OCA catalog URL', async () => {
    const extracted = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      timedtexttracks: [{
        new_track_id: 'T:2:0;1;en;0;0;0;',
        bcp47: 'en',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          'webvtt-lssdh-ios8': { downloadUrls: { primary: OCA_URL } },
        },
      }],
    });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok || extracted.value[0] === undefined) return;
    const body = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello';
    const fetcher = vi.fn(async () => ({
      ok: true,
      url: OCA_URL,
      headers: new Headers({
        'content-length': String(new TextEncoder().encode(body).byteLength),
        'content-type': 'text/vtt',
      }),
      body: null,
      text: async () => body,
    })) as NetflixTimedTextFetch;

    const result = await downloadNetflixTimedText(fetcher, extracted.value[0]);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.body).toBe(body);
  });

  it('allows an equivalent OCA response URL with a different node and renewed signature', async () => {
    const body = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello';
    const responseUrl =
      'https://ipv4-c099-lax001.oca.nflxvideo.net/?o=1&v=42&e=2000000000&t=renewed';
    const fetcher = vi.fn(async () => ({
      ok: true,
      url: responseUrl,
      headers: new Headers({ 'content-type': 'text/vtt' }),
      body: null,
      text: async () => body,
    })) as NetflixTimedTextFetch;

    const result = await downloadNetflixTimedText(fetcher, ocaResource());

    expect(result.ok).toBe(true);
  });

  it('allows an equivalent strict response after CDN, range, and token rotation', async () => {
    const requestedUrl =
      'https://ipv4-c001-lax001.nflxvideo.net/timedtext/en/range/0-100/track.vtt?trackid=en-main&token=old';
    const finalUrl =
      'https://ipv4-c099-lax001.nflxvideo.net/timedtext/en/range/101-200/track.vtt?trackid=en-main&token=renewed';
    const extracted = extractNetflixCatalogDownloadResources({
      movieId: 8_012_345,
      timedtexttracks: [{
        trackId: 'en-main',
        bcp47: 'en-US',
        rawTrackType: 'SUBTITLES',
        ttDownloadables: {
          webvtt: { downloadUrls: { primary: requestedUrl } },
        },
      }],
    });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok || extracted.value[0] === undefined) return;
    const fetcher = vi.fn(async () => ({
      ok: true,
      url: finalUrl,
      headers: new Headers({ 'content-type': 'text/vtt' }),
      body: null,
      text: async () => 'WEBVTT',
    })) as NetflixTimedTextFetch;

    const result = await downloadNetflixTimedText(fetcher, extracted.value[0]);

    expect(result.ok).toBe(true);
  });

  it('performs a real GET and returns a strict WEBVTT payload with catalog identity', async () => {
    const body = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello';
    const fetcher: NetflixTimedTextFetch = vi.fn(async (_input, init) => {
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return withResponseUrl(new Response(body, {
        status: 200,
        headers: {
          'content-length': String(new TextEncoder().encode(body).byteLength),
          'content-type': 'text/vtt; charset=utf-8',
        },
      }));
    });
    const selected = resource();

    const result = await downloadNetflixTimedText(fetcher, selected);

    expect(fetcher).toHaveBeenCalledWith(
      selected.url,
      expect.objectContaining({ method: 'GET', credentials: 'omit' }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        type: 'timed-text',
        titleId: '8012345',
        resourceId: selected.resourceId,
        trackId: 'en-main',
        language: 'en-US',
        format: 'webvtt',
        body,
      },
    });
    expect(JSON.stringify(result)).not.toContain(selected.url);
  });

  it.each([
    {
      name: 'arrayBuffer',
      response(body: string) {
        const bytes = new TextEncoder().encode(body);
        return {
          ok: true,
          url: EN_URL,
          headers: new Headers({ 'content-type': 'application/ttml+xml' }),
          body: null,
          arrayBuffer: vi.fn(async () => bytes.buffer),
        };
      },
    },
    {
      name: 'text',
      response(body: string) {
        return {
          ok: true,
          url: EN_URL,
          headers: new Headers({ 'content-type': 'text/xml' }),
          body: null,
          text: vi.fn(async () => body),
        };
      },
    },
  ])('bounded-reads TTML through $name fallback', async ({ response }) => {
    const body = '<?xml version="1.0"?><tt><body /></tt>';
    const fetcher = vi.fn(async () => response(body)) as NetflixTimedTextFetch;

    const result = await downloadNetflixTimedText(fetcher, resource());

    expect(result.ok && result.value.format).toBe('ttml');
    expect(result.ok && result.value.body).toBe(body);
  });

  it('rejects oversized declared and streamed bodies and cancels the reader', async () => {
    const declared = vi.fn(async () =>
      withResponseUrl(new Response('WEBVTT', {
        headers: {
          'content-length': '100',
          'content-type': 'text/vtt',
        },
      })),
    );
    expectErrorCode(
      await downloadNetflixTimedText(declared, resource(), { maxBytes: 32 }),
      'netflix_timed_text_too_large',
    );

    const cancel = vi.fn(async () => undefined);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('WEBVTT\n') })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(32) });
    const streamed = vi.fn(async () => ({
      ok: true,
      url: EN_URL,
      headers: new Headers({ 'content-type': 'text/vtt' }),
      body: { getReader: () => ({ read, cancel }) },
    })) as NetflixTimedTextFetch;
    expectErrorCode(
      await downloadNetflixTimedText(streamed, resource(), { maxBytes: 16 }),
      'netflix_timed_text_too_large',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'unsafe title identity',
      selected: () => resource({ titleId: '../unsafe-title' }),
      fetcher: () => vi.fn(),
      code: 'netflix_timed_text_resource_invalid' as const,
    },
    {
      name: 'forged non-Netflix resource',
      selected: () => resource({ url: 'https://evil.example/timedtext/a.vtt' }),
      fetcher: () => vi.fn(),
      code: 'netflix_timed_text_resource_invalid' as const,
    },
    {
      name: 'non-Netflix redirect',
      selected: () => resource(),
      fetcher: () =>
        vi.fn(async () => ({
          ok: true,
          url: 'https://evil.example/timedtext/redirect.vtt',
          headers: new Headers({ 'content-type': 'text/vtt' }),
          body: null,
          text: async () => 'WEBVTT',
        })) as NetflixTimedTextFetch,
      code: 'netflix_timed_text_resource_invalid' as const,
    },
    {
      name: 'missing final response URL',
      selected: () => resource(),
      fetcher: () =>
        vi.fn(async () => ({
          ok: true,
          headers: new Headers({ 'content-type': 'text/vtt' }),
          body: null,
          text: async () => 'WEBVTT',
        })) as NetflixTimedTextFetch,
      code: 'netflix_timed_text_resource_invalid' as const,
    },
    {
      name: 'different strict Netflix timed-text resource redirect',
      selected: () => resource(),
      fetcher: () =>
        vi.fn(async () => ({
          ok: true,
          url: EN_ALT_URL,
          headers: new Headers({ 'content-type': 'text/vtt' }),
          body: null,
          text: async () => 'WEBVTT',
        })) as NetflixTimedTextFetch,
      code: 'netflix_timed_text_resource_invalid' as const,
    },
    {
      name: 'OCA redirect with a different video identity',
      selected: () => ocaResource(),
      fetcher: () =>
        vi.fn(async () => ({
          ok: true,
          url: 'https://ipv4-c002-lax001.oca.nflxvideo.net/?o=1&v=99&e=2000000000&t=renewed',
          headers: new Headers({ 'content-type': 'text/vtt' }),
          body: null,
          text: async () => 'WEBVTT',
        })) as NetflixTimedTextFetch,
      code: 'netflix_timed_text_resource_invalid' as const,
    },
    {
      name: 'OCA redirect with a different object identity',
      selected: () => ocaResource(),
      fetcher: () =>
        vi.fn(async () => ({
          ok: true,
          url: 'https://ipv4-c002-lax001.oca.nflxvideo.net/?o=99&v=42&e=2000000000&t=renewed',
          headers: new Headers({ 'content-type': 'text/vtt' }),
          body: null,
          text: async () => 'WEBVTT',
        })) as NetflixTimedTextFetch,
      code: 'netflix_timed_text_resource_invalid' as const,
    },
    {
      name: 'OCA redirect with duplicate video identity parameters',
      selected: () => ocaResource(),
      fetcher: () =>
        vi.fn(async () => ({
          ok: true,
          url: 'https://ipv4-c002-lax001.oca.nflxvideo.net/?o=1&v=42&v=42&e=2000000000&t=renewed',
          headers: new Headers({ 'content-type': 'text/vtt' }),
          body: null,
          text: async () => 'WEBVTT',
        })) as NetflixTimedTextFetch,
      code: 'netflix_timed_text_resource_invalid' as const,
    },
    {
      name: 'media content type',
      selected: () => resource(),
      fetcher: () =>
        vi.fn(async () =>
          withResponseUrl(new Response(
            'WEBVTT',
            { headers: { 'content-type': 'video/mp4' } },
          )),
        ),
      code: 'netflix_timed_text_media_response' as const,
    },
    {
      name: 'malformed subtitle body',
      selected: () => resource(),
      fetcher: () =>
        vi.fn(async () =>
          withResponseUrl(new Response('<html>not subtitles</html>', {
            headers: { 'content-type': 'text/plain' },
          })),
        ),
      code: 'netflix_timed_text_invalid_body' as const,
    },
  ])('fails closed for $name', async ({ selected, fetcher, code }) => {
    const request = fetcher();
    const result = await downloadNetflixTimedText(request, selected());
    expectErrorCode(result, code);
    if (
      code === 'netflix_timed_text_resource_invalid' &&
      selected().url.includes('evil.example')
    ) {
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('supports AbortSignal and sanitizes thrown fetch errors', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => {
      throw new Error(`signed-secret ${EN_URL}`);
    });

    expectErrorCode(
      await downloadNetflixTimedText(fetcher, resource(), {
        signal: controller.signal,
      }),
      'netflix_timed_text_aborted',
    );
    expect(fetcher).not.toHaveBeenCalled();

    const failed = await downloadNetflixTimedText(fetcher, resource());
    expectErrorCode(failed, 'netflix_timed_text_fetch_failed');
  });
});
