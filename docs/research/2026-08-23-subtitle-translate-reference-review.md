# Subtitle-Translate Reference Review

**Reviewed repository:** [`keixhuiq/Subtitle-Translate`](https://github.com/keixhuiq/Subtitle-Translate)

**Reviewed commit:** [`335033f0bbbff06a9f68d45b963886aec78bb011`](https://github.com/keixhuiq/Subtitle-Translate/tree/335033f0bbbff06a9f68d45b963886aec78bb011)

**Review date:** 2026-08-23

## Purpose

This review identifies behaviors and architectural lessons that can inform SubTwin. It is not a dependency evaluation and does not authorize copying source code. SubTwin will independently implement the selected ideas in TypeScript with tests.

## Repository snapshot

The reviewed project is a plain JavaScript Manifest V3 extension supporting Netflix, Crunchyroll, ABEMA, local subtitle import, multiple translation providers, pretranslation, and custom bilingual rendering. Its README describes full-track pretranslation, playback-neighborhood prioritization, configurable context windows, and session-scoped caching.

Local review found:

- JavaScript syntax and `manifest.json` parsing succeed.
- No package/build configuration or automated tests are present.
- No `LICENSE`, `COPYING`, or equivalent license file is present.
- Netflix behavior is concentrated in a small MAIN-world interceptor and a content script of more than 2,000 lines.

## Behaviors worth independently reimplementing

### 1. Narrow MAIN-world subtitle interception

The reference patches both `fetch` and `XMLHttpRequest` in the page's MAIN world. It clones only candidate responses, skips `video/*` and `audio/*`, sniffs the first response chunk, and abandons data above 10 MB. This avoids reading every media fragment into memory.

Source: [`interceptor.js` lines 12–163](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/interceptor.js#L12-L163)

SubTwin adaptation:

- preserve the first-chunk sniff and strict size/content-type limits;
- use typed page-to-content messages with a per-session nonce, source check, URL validation, text-size validation, and bounded early-message buffering;
- keep Netflix URL heuristics in one adapter;
- avoid leaking cookies, authorization headers, media payloads, or DRM data;
- never log or persist signed Netflix timed-text URLs;
- store XHR metadata in a `WeakMap` rather than adding public properties to page objects.

### 2. Stable track and cue identity

The reference canonicalizes CDN URLs by removing `/range/start-end` while retaining a small stable parameter set. It hashes normalized cue time/text and freezes a track identity when sufficient cue data has settled.

Source: [`bridge.js` lines 78–144](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L78-L144), [`bridge.js` lines 374–538](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L374-L538)

SubTwin adaptation:

- canonicalize segmented timed-text URLs before deduplication;
- separate resource identity, track identity, content revision, and cue identity;
- include explicit language/variant metadata where Netflix exposes it;
- keep official English and Simplified Chinese as separate tracks and align them by time;
- include episode identity and subtitle-content hash in persistent cache keys.

### 3. Provisional/confirmed track lifecycle

The reference translates only the current neighborhood for a provisional track, then starts bounded whole-track work after the track has been active long enough or covers enough of the video. This reduces accidental work on previews, ads, and inactive language tracks.

Source: [`bridge.js` lines 18–34](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L18-L34), [`bridge.js` lines 540–620](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L540-L620)

SubTwin adaptation:

- model `provisional`, `confirmed`, and `disposed` states explicitly;
- use a generation/session token so callbacks from an old episode cannot update the new one;
- dispose observers, queued work, timers, and overlay state on route or episode change;
- treat observed subtitle fragments as evidence of presence, not proof of absence;
- never unlock an external provider until an authoritative current-title catalog confirms that official Simplified Chinese is absent.

### 4. Urgent/bulk translation scheduling

The reference maintains urgent and bulk queues, reserves global concurrency for urgent work, promotes a queued bulk task when playback reaches it, limits per-track/background concurrency, bounds queue length, and keeps retry in a single layer.

Source: [`bridge.js` lines 150–358](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L150-L358)

SubTwin adaptation:

- preserve the two-tier priority model, reserved urgent capacity, promotion, deduplication, bounded queues, and disposal;
- make the scheduler provider-neutral;
- use structured multi-cue JSON batches for DeepSeek;
- use single-cue tasks for experimental Google Free because its endpoint has no reliable structured batch contract;
- keep cache entries and in-flight identities separated by provider;
- prohibit automatic cross-provider fallback;
- abort the old provider generation on provider switch and reject all late render/cache callbacks.

### 5. Native subtitle DOM as the display clock

The reference uses a `MutationObserver` on Netflix's native subtitle container as the primary display signal. It matches native text to a captured cue and uses `video.currentTime` as a supporting signal. This closely follows the text Netflix actually displays.

Source: [`bridge.js` lines 1529–1620](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L1529-L1620)

SubTwin adaptation:

- use the native DOM mutation signal as the preferred clock when available;
- retain binary-search time lookup as fallback and for imported/manual tracks;
- centralize Netflix selectors and rebinding logic in the Netflix adapter;
- avoid scanning every cue on every animation frame.

### 6. Hide only after successful render, restore on failure

The reference does not hide Netflix's native subtitles until its custom overlay has non-empty content. It restores the native layer when the custom render path is missing or stale.

Source: [`bridge.js` lines 1298–1324](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L1298-L1324), [`bridge.js` lines 1837–1872](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L1837-L1872)

SubTwin adaptation:

- treat native-subtitle restoration as a release gate;
- make hide/show operations idempotent;
- mount the WXT Shadow DOM overlay before suppressing native text;
- restore on adapter failure, renderer failure, disable, navigation, or disposal.

### 7. Structured errors, one retry layer, and bounded cache writes

The reference returns `{ ok, text, code, retriable }`, applies `AbortController` timeouts, retries transient failures in one layer, versions prompts, and debounces writes to a size-limited session cache.

Source: [`background.js` lines 24–68](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/background.js#L24-L68), [`background.js` lines 140–260](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/background.js#L140-L260)

SubTwin adaptation:

- preserve typed errors, bounded exponential backoff, timeouts, one retry owner, cache caps, and debounced persistence;
- use persistent local storage/IndexedDB rather than session-only cache;
- include provider, model, prompt version, source-track hash, and target language in cache identity;
- never store credentials with translations.

## Behaviors not to copy

### Missing official bilingual routing

The reference anchors the currently displayed native track and translates it. It does not implement SubTwin's primary invariant: when official English and Simplified Chinese tracks are available, display both and make zero external provider calls.

### One API request per cue

The reference includes surrounding cues in the prompt but translates only one current cue per request. This can produce good contextual output, but it increases request count and rate-limit pressure.

Source: [`background.js` lines 188–260](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/background.js#L188-L260)

SubTwin uses contextual DeepSeek batches with stable cue IDs and strict JSON results. Google Free remains single-cue because it is a different provider with a different reliability contract.

### Monolithic content scripts

Parser, track lifecycle, scheduling, state, rendering, local import, export, and UI concerns are combined in large untyped files. SubTwin keeps these as tested TypeScript modules with narrow interfaces.

### Secret propagation and broad optional permissions

The reference sends full settings through content/background messages and supports arbitrary optional origins. SubTwin supports fixed provider hosts in the MVP, keeps the DeepSeek key background-only, and never includes credentials in page/content messages.

Source: [`manifest.json`](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/manifest.json), [`bridge.js` lines 360–367](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L360-L367)

### Parser assumptions without fixtures

The reference parser accepts several time syntaxes but assumes a 24fps interpretation for some fractional forms without reading TTML timing parameters. SubTwin implements only observed formats first, stores synthetic fixtures, and tests ticks, milliseconds, frames, namespaces, nested spans, `<br>`, malformed XML, and WebVTT settings explicitly.

Source: [`bridge.js` lines 1129–1255](https://github.com/keixhuiq/Subtitle-Translate/blob/335033f0bbbff06a9f68d45b963886aec78bb011/bridge.js#L1129-L1255)

## Google translation decision

SubTwin MVP exposes two explicit external providers when official Simplified Chinese is unavailable:

1. **Google Free (experimental):** no key, fast single-cue translation through the undocumented `client=gtx` endpoint, no availability guarantee, no automatic DeepSeek fallback.
2. **DeepSeek:** user-supplied key, context-aware structured batches, higher expected subtitle quality, provider-specific caching and error reporting.

The Google Free request uses an HTTPS GET query with `sl=en`, `tl=zh-CN`, `dt=t`, and the cue text in `q`. SubTwin therefore versions the response parser, limits concurrency and dispatch rate independently, never logs the full URL/query or subtitle text, does not automatically retry 403 responses, and uses bounded 429 backoff/cooldown. The UI discloses that query text may still appear in Google, browser, proxy, or network diagnostics. A fresh installation selects neither provider; subtitles are not sent externally until the user explicitly chooses one.

Google's documented Cloud Translation NMT API is separate. Google currently documents a monthly credit covering the first 500,000 NMT characters, but it requires Cloud setup and authentication. It may be considered later as `GoogleCloudProvider`; it is not the no-key Google Free provider.

Sources: [Google Cloud Translation pricing](https://cloud.google.com/products/translate/pricing), [Cloud Translation Basic API](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate)

## Licensing boundary

The reference repository contains no declared license. GitHub documents that without a license, default copyright applies and others may not reproduce, distribute, or create derivative works from the code.

Source: [GitHub licensing documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)

SubTwin may learn from observable behavior and general engineering patterns, but it will not copy functions, comments, test fixtures, or substantial code from this repository without explicit permission from its author.

## Resulting SubTwin decisions

- Keep official Simplified Chinese above every external provider.
- Add explicit `google-free` and `deepseek` provider selection.
- Default to `provider = unset` and make no external request before explicit choice.
- Never auto-fallback between providers.
- Require an authoritative Netflix track catalog before concluding that official Simplified Chinese is absent.
- Reimplement first-chunk sniffing and CDN range canonicalization.
- Add provisional/confirmed/disposed track states and generation-safe cleanup.
- Use provider-neutral urgent/bulk scheduling with reserved urgent capacity.
- Batch DeepSeek; translate Google Free cues individually.
- Version and throttle Google Free separately, map the target to `zh-CN`, and keep query strings out of logs.
- Use native subtitle mutations as the preferred display clock with time-based fallback.
- Hide Netflix native subtitles only after successful custom rendering and always restore them on failure.
- Keep credentials background-only and cache translations persistently by provider.
- Abort and invalidate stale provider/episode generations before rendering or cache writes.
- Require tests for every borrowed behavior and Netflix-specific assumption.
