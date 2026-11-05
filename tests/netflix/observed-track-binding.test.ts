import { describe, expect, it, vi } from 'vitest';

import {
  installMainWorldNetflixRuntime,
  NETFLIX_CONTROL_SOURCE,
  type NetflixRuntimeWindow,
} from '../../src/netflix/runtime';
import type {
  NetflixCatalogTimedTextBinding,
  NetworkProbeOptions,
} from '../../src/netflix/probe';
import { installFetchProbe } from '../../src/netflix/probe';
import type { NetflixCatalogPayload } from '../../src/netflix/bridge';
import { ok } from '../../src/shared/result';

const NONCE = '0123456789abcdef0123456789abcdef';
const ENGLISH_BODY = '<tt xml:lang="en"><body /></tt>';
const RESOURCE_ID = 'tt_0123456789abcdef';
const OCA_URL = 'https://example.oca.nflxvideo.net/?o=english&v=video&e=expires';

class FakeWindow implements NetflixRuntimeWindow {
  readonly location = {
    origin: 'https://www.netflix.com',
    pathname: '/watch/title-1',
  };
  readonly sent: unknown[] = [];
  readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly entries: Array<{ name: string }> = [];
  readonly performance = { getEntriesByType: () => this.entries };
  readonly sourceFetch = vi.fn(async () => {
    const response = new Response(ENGLISH_BODY, {
      headers: { 'content-type': 'text/xml' },
    });
    Object.defineProperty(response, 'url', { value: OCA_URL });
    return response as unknown as Awaited<ReturnType<NetflixRuntimeWindow['fetch']>>;
  });
  fetch: NetflixRuntimeWindow['fetch'] = this.sourceFetch;
  XMLHttpRequest = class { open(): void {} send(): void {} } as never;
  readonly JSON = { parse: JSON.parse };

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    this.sent.push(data);
  }

  connect(): void {
    const data = {
      protocol: 'subtwin.netflix.bridge', version: 1,
      source: NETFLIX_CONTROL_SOURCE, type: 'connect', nonce: NONCE, generation: 1,
    };
    for (const listener of this.listeners) {
      listener({ data, origin: this.location.origin, source: this } as unknown as MessageEvent);
    }
  }
}

function createHarness(duplicateEnglish = true, originalTrackId = 'en-main', realFetchProbe = false, noCatalog = false) {
  const window = new FakeWindow();
  let probe: NetworkProbeOptions | undefined;
  let catalogAvailable = !noCatalog;
  let catalog: NetflixCatalogPayload = {
    type: 'catalog', titleId: 'title-1', authority: 'authoritative',
    tracks: [
      { id: 'en-main', language: 'en', kind: 'subtitle' },
      ...(duplicateEnglish
        ? [{ id: 'en-cc', language: 'en', kind: 'closed-caption' } as const]
        : []),
      { id: 'zh-main', language: 'zh-Hans', kind: 'subtitle' },
    ],
  };
  const captureEvents = vi.fn();
  const restore = vi.fn();
  let poll: (() => void) | undefined;
  const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
  const runtime = installMainWorldNetflixRuntime({
    window,
    readPlayerCatalog: () => ok({ ...catalog, tracks: catalogAvailable ? catalog.tracks : [] }),
    preparePlayerTrackCapture: () => ok({
      titleId: catalog.titleId, originalTrackId, switchTo: () => true, restore,
    }),
    onTrackCaptureEvent: captureEvents,
    scheduleCatalogPoll: (callback) => { poll = callback; return () => undefined; },
    scheduleTrackCaptureTimeout: (callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    installFetch: (target, options) => {
      probe = options;
      return realFetchProbe ? installFetchProbe(target, options) : { dispose() {} };
    },
    installXhr: () => ({ dispose() {} }),
    extractCatalogResources: () => ok([]),
  });
  window.connect();
  if (probe === undefined) throw new Error('Probe was not installed');
  const options = probe;
  const emit = (
    requestBinding?: NetflixCatalogTimedTextBinding,
    language = 'en',
    body = ENGLISH_BODY,
  ): void => {
    options.onTimedText({
      type: 'timed-text', resourceId: RESOURCE_ID,
      trackId: 'oca_0123456789abcdef', language, format: 'ttml', body,
      ...(requestBinding === undefined ? {} : { requestBinding }),
    });
  };
  return {
    window, emit, captureEvents, restore, runtime,
    poll: () => poll?.(),
    remember(binding: NetflixCatalogTimedTextBinding) {
      options.onTimedTextRequest?.({ resourceId: RESOURCE_ID, binding });
    },
    timeout() {
      const timer = timers.findLast((candidate) => !candidate.cancelled);
      if (timer !== undefined) { timer.cancelled = true; timer.callback(); }
    },
    changeTitle(uniqueEnglish = false, alignRoute = false) {
      window.location.pathname = '/watch/title-2';
      if (alignRoute) options.onDiagnostic?.('metadata_candidate_observed');
      catalogAvailable = true;
      catalog = {
        ...catalog, titleId: 'title-2',
        tracks: uniqueEnglish ? catalog.tracks.filter(({ id }) => id !== 'en-cc') : catalog.tracks,
      };
      poll?.();
    },
  };
}

function bridgedTracks(window: FakeWindow): unknown[] {
  return window.sent.flatMap((candidate) => {
    const envelope = candidate as { payload?: { type: string; trackId?: string } };
    return envelope.payload?.type === 'timed-text' ? [envelope.payload.trackId] : [];
  });
}

describe('request-bound Netflix OCA track ownership', () => {
  it('uses the request binding to recover English when English CC has the same language', () => {
    const harness = createHarness();
    harness.emit({ titleId: 'title-1', trackId: 'en-main' });
    expect(bridgedTracks(harness.window)).toEqual(['en-main']);
    harness.runtime.dispose();
  });

  it('retains the request-time CC owner instead of assigning its delayed body to English', () => {
    const harness = createHarness(true, 'en-cc');
    harness.emit({ titleId: 'title-1', trackId: 'en-cc' });
    expect(bridgedTracks(harness.window)).toEqual(['en-cc']);
    harness.runtime.dispose();
  });

  it('keeps an unbound ambiguous body pending and reports the mismatch', () => {
    const harness = createHarness();
    harness.emit();
    expect(bridgedTracks(harness.window)).toEqual([]);
    expect(harness.window.sent).toContainEqual(expect.objectContaining({
      payload: { type: 'diagnostic', code: 'download_candidate_unmatched' },
    }));
    harness.runtime.dispose();
  });

  it('rejects a request binding from the previous title even if track IDs are reused', () => {
    const harness = createHarness();
    harness.changeTitle();
    harness.emit({ titleId: 'title-1', trackId: 'en-main' });
    expect(bridgedTracks(harness.window)).toEqual([]);
    harness.runtime.dispose();
  });

  it('rejects a bound English body whose embedded TTML language is Chinese', () => {
    const harness = createHarness();
    harness.emit({ titleId: 'title-1', trackId: 'en-main' }, 'en',
      '<tt xml:lang="zh-Hans"><body /></tt>');
    expect(bridgedTracks(harness.window)).toEqual([]);
    harness.runtime.dispose();
  });

  it('preserves the unique-language path when no request binding is available', () => {
    const harness = createHarness(false);
    harness.emit();
    expect(bridgedTracks(harness.window)).toEqual(['en-main']);
    harness.runtime.dispose();
  });

  it('retries a pending performance body after its request identity is observed', () => {
    const harness = createHarness();
    harness.emit();
    harness.remember({ titleId: 'title-1', trackId: 'en-main' });
    harness.poll();
    expect(bridgedTracks(harness.window)).toEqual(['en-main']);
    harness.runtime.dispose();
  });

  it('does not guess when one resource has conflicting request-time owners', () => {
    const harness = createHarness();
    harness.remember({ titleId: 'title-1', trackId: 'en-main' });
    harness.remember({ titleId: 'title-1', trackId: 'en-cc' });
    harness.emit();
    expect(bridgedTracks(harness.window)).toEqual([]);
    harness.runtime.dispose();
  });

  it('limits unsuccessful capture to two attempts per track and reports failure', () => {
    const harness = createHarness();
    for (let index = 0; index < 12; index += 1) {
      harness.timeout();
      harness.poll();
    }
    expect(harness.captureEvents.mock.calls.filter(([event]) =>
      event.state === 'switch_started')).toHaveLength(4);
    expect(harness.restore).toHaveBeenCalledTimes(2);
    expect(harness.window.sent).toContainEqual(expect.objectContaining({
      payload: { type: 'diagnostic', code: 'display_unavailable' },
    }));
    harness.runtime.dispose();
  });

  it('never creates track ownership by observing its own performance re-download', async () => {
    const harness = createHarness(true, 'en-main', true);
    harness.emit({ titleId: 'title-1', trackId: 'zh-main' }, 'zh-Hans',
      '<tt xml:lang="zh-Hans"><body /></tt>');
    harness.window.entries.push({ name: OCA_URL });
    harness.poll();
    await vi.waitFor(() => expect(harness.window.sent).toContainEqual(expect.objectContaining({
      payload: { type: 'diagnostic', code: 'download_candidate_unmatched' },
    })));
    expect(harness.window.sourceFetch).toHaveBeenCalled();
    expect(bridgedTracks(harness.window)).toEqual(['zh-main']);
    harness.runtime.dispose();
  });

  it.each([false, true])('discards an old ambiguous body before a new unique catalog (route alignment: %s)', (alignRoute) => {
    const harness = createHarness();
    harness.emit();
    harness.changeTitle(true, alignRoute);
    expect(bridgedTracks(harness.window)).toEqual([]);
    harness.runtime.dispose();
  });

  it('clears request ownership when the title changes before accepting new request evidence', () => {
    const harness = createHarness();
    harness.remember({ titleId: 'title-1', trackId: 'en-main' });
    harness.changeTitle();
    harness.remember({ titleId: 'title-2', trackId: 'en-main' });
    harness.emit();
    expect(bridgedTracks(harness.window)).toEqual(['en-main']);
    harness.runtime.dispose();
  });

  it('discards a body observed before the first catalog when the watch route changes', () => {
    const harness = createHarness(true, 'en-main', false, true);
    harness.emit();
    harness.changeTitle(true, true);
    expect(bridgedTracks(harness.window)).toEqual([]);
    harness.runtime.dispose();
  });

  it('never retries an old title performance entry against the new title catalog', async () => {
    const harness = createHarness(true, 'en-main', true);
    harness.window.entries.push({ name: OCA_URL });
    harness.poll();
    await vi.waitFor(() => expect(harness.window.sent).toContainEqual(expect.objectContaining({
      payload: { type: 'diagnostic', code: 'download_candidate_unmatched' },
    })));
    harness.changeTitle(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bridgedTracks(harness.window)).toEqual([]);
    harness.runtime.dispose();
  });
});
