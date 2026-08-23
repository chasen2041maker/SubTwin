# SubTwin MVP Implementation Plan

**Goal:** Build a personal-use Chrome extension that displays official English/Simplified Chinese Netflix subtitles when available and otherwise translates English through the user's explicitly selected provider: experimental no-key Google Free or context-aware DeepSeek.

**Architecture:** A WXT Manifest V3 extension separates Netflix page instrumentation, normalized subtitle-domain logic, provider-neutral background translation scheduling, persistent local storage, and an isolated React subtitle overlay. Official tracks always take precedence; external providers are explicit, isolated, and never used as silent fallbacks for one another.

**Tech Stack:** WXT, TypeScript, React, Vitest, plain CSS/CSS variables, Chrome Extension APIs.

---

### chunk-01: Extension scaffold and shared contracts

**Files:**

- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `wxt.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `entrypoints/background.ts`
- Create: `src/shared/result.ts`
- Create: `src/shared/messages.ts`
- Create: `README.md`

**Changes:**

Initialize a WXT React/TypeScript Manifest V3 project targeting Chrome. Configure scripts for development, type-checking, unit tests, production build, and zipped release output. Request only Netflix page access, the fixed DeepSeek and Google Translate provider hosts, and storage permissions. If the technical probe proves that extension-originated reads require a Netflix timed-text CDN host, add only the smallest observed Netflix-owned host pattern and document why; do not add arbitrary optional origins. Define typed `Result` and cross-context message envelopes before feature code. Document local loading, experimental-provider labeling, and the rule that API keys never enter source files or Git.

**Acceptance Criteria:**

- [ ] `pnpm test`, `pnpm typecheck`, and `pnpm build` complete successfully.
- [ ] The unpacked build contains a valid Manifest V3 background service worker and no embedded API key.
- [ ] Extension permissions are limited to storage, Netflix pages, `api.deepseek.com`, and `translate.googleapis.com`; no arbitrary optional host permission is present.

**Dependencies:** none

### chunk-02: Subtitle domain, parsers, and official-track alignment

**Files:**

- Create: `src/subtitles/types.ts`
- Create: `src/subtitles/normalize.ts`
- Create: `src/subtitles/ttml.ts`
- Create: `src/subtitles/webvtt.ts`
- Create: `src/subtitles/align.ts`
- Create: `tests/fixtures/subtitles/sample.ttml`
- Create: `tests/fixtures/subtitles/sample.vtt`
- Create: `tests/subtitles/parsers.test.ts`
- Create: `tests/subtitles/align.test.ts`

**Changes:**

Define normalized track/cue types with millisecond timestamps and language metadata. Implement small, deterministic TTML and WebVTT parsers for the formats observed by the technical probe, keeping format-specific details behind parser functions. Cover TTML `tickRate`, `frameRate`, `frameRateMultiplier`, namespaces, nested spans, `<br>`, entities, and malformed XML without assuming 24 fps; preserve WebVTT cue settings while normalizing visible text. Implement overlap-based official-track alignment with tolerance, adjacent-cue merging, deterministic tie-breaking, and explicit gaps instead of index-based pairing.

**Acceptance Criteria:**

- [ ] TTML and WebVTT fixtures normalize to stable cue IDs, timestamps, and plain text, including namespaces, nested spans, `<br>`, entities, and WebVTT settings.
- [ ] TTML tick/frame timing respects `tickRate`, `frameRate`, and `frameRateMultiplier`; no parser path hard-codes 24 fps.
- [ ] Alignment handles one-to-one, one-to-many, many-to-one, near-touching, and no-match fixtures.
- [ ] Malformed subtitle input returns typed errors without throwing across extension boundaries.
- [ ] Alignment never invokes or references a translation provider.

**Dependencies:** chunk-01

### chunk-03: Netflix subtitle-source adapter and technical probe

**Files:**

- Create: `src/subtitles/source.ts`
- Create: `src/netflix/types.ts`
- Create: `src/netflix/adapter.ts`
- Create: `src/netflix/native-subtitle-clock.ts`
- Create: `entrypoints/netflix-main-world.content.ts`
- Create: `entrypoints/netflix.content/index.tsx`
- Create: `tests/netflix/adapter.test.ts`
- Create: `tests/netflix/native-subtitle-clock.test.ts`
- Modify: `src/shared/messages.ts`
- Modify: `wxt.config.ts`

**Changes:**

Add an idempotent main-world probe that observes only relevant player metadata and timed-text network responses without delaying or changing the page's original fetch/XHR results, then sends sanitized data to the isolated content script through a narrow validated message protocol. Reimplement first-chunk subtitle sniffing, audio/video and over-10-MB rejection, fetch/XHR coverage, CDN range URL canonicalization, and bounded early-message buffering based on independently reviewed behavior. Never log or persist raw signed timed-text URLs. Build a Netflix adapter that discovers title/episode identity, identifies English and Simplified Chinese track candidates, retrieves timed text using the active browser session, and delegates parsing to chunk-02. Distinguish an authoritative current-title track catalog from provisional tracks/fragments: partial network observations may establish presence but never absence, and external translation remains locked until the catalog confirms that Simplified Chinese is unavailable. Provisional active source tracks may drive only the current playback neighborhood; bulk scheduling requires an active, confirmed track. Model provisional/confirmed/disposed tracks, generation-safe cleanup, player remount, episode change, missing track, unsupported payload, and adapter-version mismatch as typed events/errors. Add a disposable native-subtitle `MutationObserver` clock that emits sanitized display ticks for chunk-06. Keep all Netflix response shapes and selectors inside `src/netflix`.

**Acceptance Criteria:**

- [ ] A logged-in manual probe can enumerate English and Simplified Chinese subtitle availability for a selected Netflix title.
- [ ] Timed-text data reaches the isolated content script as normalized tracks without exposing cookies, authorization headers, or media/DRM payloads.
- [ ] Fetch/XHR instrumentation is idempotent, never delays or changes original page responses, skips audio/video, and rejects candidate bodies above 10 MB.
- [ ] Page-to-content messages require a session nonce and validate source, URL, payload shape, and payload size before ingestion.
- [ ] Segmented URLs for the same timed-text resource canonicalize to one resource identity without merging distinct language tracks.
- [ ] Provisional fragments cannot unlock external translation; only an authoritative current-title catalog can confirm official Simplified Chinese is absent.
- [ ] Only the current neighborhood may be scheduled from a provisional active source track; bulk work requires active and confirmed state.
- [ ] Old-generation callbacks are discarded, native subtitle observers are disposable, and raw signed timed-text URLs never enter logs or persistence.
- [ ] Episode changes and player remounts produce a new session identity and dispose stale listeners.
- [ ] Unsupported Netflix payloads restore/preserve native subtitle behavior and emit a non-sensitive diagnostic code.

**Dependencies:** chunk-01, chunk-02

### chunk-04: Translation providers, validation, scheduling, and persistent cache

**Files:**

- Create: `src/translation/types.ts`
- Create: `src/translation/provider.ts`
- Create: `src/translation/google-free.ts`
- Create: `src/translation/deepseek.ts`
- Create: `src/translation/prompt.ts`
- Create: `src/translation/validate.ts`
- Create: `src/translation/scheduler.ts`
- Create: `src/translation/cache.ts`
- Create: `tests/translation/deepseek.test.ts`
- Create: `tests/translation/google-free.test.ts`
- Create: `tests/translation/scheduler.test.ts`
- Create: `tests/translation/cache.test.ts`
- Modify: `entrypoints/background.ts`
- Modify: `src/shared/messages.ts`

**Changes:**

Define a provider-neutral translation contract and implement both providers in the background worker. `GoogleFreeProvider` calls the undocumented no-key `client=gtx` endpoint for individual English cues using `sl=en`, `tl=zh-CN`, `dt=t`, `URLSearchParams`, and a versioned `google-free-v1` nested-array parser. Give it provider-specific throttling (initially at most two concurrent requests and at least 200 ms between starts), no automatic retry for 403, bounded backoff for 429/transient failures, and a cooldown after repeated rate limits; never log its query string because GET URLs contain subtitle text. `PersonalDeepSeekProvider` sends strict JSON chat-completion requests with thinking disabled, stable cue IDs, target cues, read-only surrounding context, and a versioned translation prompt. Split common validation from provider-specific validation: cue-ID/duplicate/explanatory-output checks apply to DeepSeek, while changed/empty array shapes apply to Google Free. Reimplement the reference project's bounded urgent/bulk scheduler concepts: reserved urgent capacity, task promotion, deduplication, provider-aware task identity, bounded queues, seek reprioritization, and one retry owner. Every task carries episode and provider generations; disposal rejects stale callbacks before rendering or cache writes. DeepSeek uses a small urgent batch and 15–25 cue background batches; Google Free uses single-cue work. Persist valid translations in IndexedDB across browser restarts by episode/track hash/provider/language/provider-contract version, plus model/prompt version for DeepSeek, with size caps and debounced writes. Neither provider ever falls back to the other.

**Acceptance Criteria:**

- [ ] DeepSeek contract tests cover success, invalid JSON, missing/duplicate IDs, empty output, 401, insufficient balance, 429, timeout, and transient server errors.
- [ ] Google Free contract tests cover multi-segment success, `en`/`zh-CN` mapping, changed/malformed/empty arrays, concurrency/dispatch limits, no automatic 403 retry, bounded 429 backoff/cooldown, timeout, and endpoint unavailability.
- [ ] A failure from either provider makes exactly zero calls to the other provider.
- [ ] Seeking promotes the new playback neighborhood ahead of queued background work without duplicating completed translations.
- [ ] Background work cannot consume capacity reserved for the current playback neighborhood.
- [ ] Only invalid or missing cues are selected for retry, with a strict retry limit.
- [ ] Repeated requests for the same provider-specific cache key survive browser restart and return locally without an API call.
- [ ] Provider/episode generation changes abort queued/in-flight work and prevent late results from rendering or entering the cache.
- [ ] API keys, authorization headers, Google query strings, cue text, and translated text never appear in logs or diagnostics; credentials never enter page/content messages.
- [ ] The background worker alone reads the DeepSeek key from storage; content scripts send only provider/task data, and `provider = unset` produces zero provider calls.

**Dependencies:** chunk-01, chunk-02

### chunk-05: Versioned settings, popup, options, and subtitle overlay

**Files:**

- Create: `src/storage/schema.ts`
- Create: `src/storage/settings.ts`
- Create: `src/renderer/SubtitleOverlay.tsx`
- Create: `src/renderer/subtitle-overlay.css`
- Create: `entrypoints/popup/App.tsx`
- Create: `entrypoints/popup/main.tsx`
- Create: `entrypoints/popup/index.html`
- Create: `entrypoints/options/App.tsx`
- Create: `entrypoints/options/main.tsx`
- Create: `entrypoints/options/index.html`
- Create: `tests/storage/settings.test.ts`
- Create: `tests/renderer/SubtitleOverlay.test.tsx`

**Changes:**

Implement versioned local settings for enablement, provider selection, DeepSeek key/model, and the approved practical appearance controls. A fresh install starts with `provider = unset`; until the user chooses, no subtitle text goes to an external service. Label Google Free as experimental/no-key, explain that it can stop working, and disclose that its GET query can expose cue text to Google and network/browser diagnostic logs; show DeepSeek as context-aware/BYOK. Build a small popup showing discovering/official/unset/Google Free/DeepSeek mode and status, and an options page with DeepSeek key testing, live subtitle preview, per-language visibility/color/size/weight, ordering, spacing, vertical offset, background opacity, shadow, and cache clearing. Create a pointer-transparent Shadow DOM overlay whose styles are driven entirely by settings and accepts normalized active-cue state without importing Netflix selectors or clocks. Hide native subtitles only after a successful custom render and restore them on every failure/disposal path.

**Acceptance Criteria:**

- [ ] Appearance changes update the preview immediately and survive browser restart.
- [ ] Settings migrations preserve valid prior values and replace invalid values with defaults.
- [ ] First-run `provider = unset` is tested; provider selection is explicit, visible, persisted, and does not copy provider credentials into content/page messages.
- [ ] The overlay renders English and Chinese independently, supports order changes, and does not intercept player controls.
- [ ] The overlay renders normalized active-cue state deterministically and contains no Netflix selector/timing logic.
- [ ] The key field is masked by default and never included in UI diagnostics or exported settings.
- [ ] Removing or failing the overlay restores/preserves Netflix native subtitles.

**Dependencies:** chunk-01, chunk-02

### chunk-06: Routing controller, integration, and release verification

**Files:**

- Create: `src/app/session-controller.ts`
- Create: `src/app/language-router.ts`
- Create: `src/app/status.ts`
- Create: `tests/app/language-router.test.ts`
- Create: `tests/app/session-controller.test.ts`
- Create: `docs/manual-verification.md`
- Modify: `entrypoints/netflix.content/index.tsx`
- Modify: `entrypoints/background.ts`
- Modify: `entrypoints/popup/App.tsx`
- Modify: `README.md`

**Changes:**

Wire collection, authoritative track-catalog gating, routing, official alignment, provider-neutral scheduling, persistent cache, status, and rendering into a disposable per-episode session controller. Use native Netflix subtitle mutation ticks from chunk-03 as the preferred display clock and binary-search `video.currentTime` lookup as fallback. Encode the invariant that discovery/`unset` states and an available official Simplified Chinese track produce zero external provider calls. When official Chinese is authoritatively absent, route only to the provider explicitly selected by the user. A provider change, later official-track discovery, disable, player remount, or episode transition increments the generation, aborts old work, clears old provider-derived overlay text, and rejects late callbacks. Handle missing English, missing DeepSeek key, Google Free unavailability, authentication/balance failure, rate limiting, offline mode, malformed responses, adapter failure, seek, fullscreen, player remount, and episode transition. Add a manual verification matrix and local installation instructions. Run build, unit tests, a packaged-extension inspection, and logged-in Netflix smoke tests.

**Acceptance Criteria:**

- [ ] Official English plus Simplified Chinese routes directly to alignment and makes exactly zero external provider calls.
- [ ] Discovery and first-run `provider = unset` states make exactly zero external provider calls.
- [ ] English-only content uses only the selected Google Free or DeepSeek provider, prioritizes initial/current translations, warms the background queue, and reuses provider-specific cached translations on replay.
- [ ] Google Free failure, DeepSeek failure, provider switching, and late official-track discovery never trigger silent cross-provider calls or stale-result rendering/cache writes.
- [ ] The zero-call matrix covers Google selected, DeepSeek selected, both provider failure paths, and `unset`; native mutation timing and time-based fallback both pass deterministic controller tests.
- [ ] Every documented failure preserves playback and leaves English/native subtitles usable.
- [ ] Fullscreen, seek, episode transition, disable/enable, and player remount do not duplicate overlays or listeners.
- [ ] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass, and manual verification results are recorded.

**Dependencies:** chunk-03, chunk-04, chunk-05

---

## Risks

- Netflix exposes no stable extension-facing subtitle API; response shapes and player lifecycle behavior can change.
- A page-world interceptor must be narrow and carefully cleaned up to avoid interfering with playback.
- Available language tags may vary (`zh-Hans`, regional Chinese labels, SDH variants) and require explicit normalization.
- TTML profiles may contain styling, spans, regions, entities, or timing expressions not represented by initial fixtures.
- DeepSeek response latency and structured-output behavior may vary; scheduler and validation must degrade gracefully.
- The no-key Google Free endpoint is undocumented, has no SLA, may rate-limit or disappear, and must not be a dependency of a future paid release.
- Google Free translates one cue without surrounding context and may be less consistent for names, pronouns, tone, and sentence fragments than contextual DeepSeek batches.
- Google Free places cue text in a GET query parameter; full request URLs must never enter application diagnostics, and the privacy disclosure must remain visible.
- Google Cloud Translation is a separate documented service with authentication and pricing; its free monthly credit must not be confused with the no-key experimental provider.
- Provider switching, episode changes, and late official-track discovery create race conditions unless queued, in-flight, rendered, and cached results are protected by generation IDs.
- An official Chinese track discovered late can cause an accidental external call unless translation remains locked behind authoritative catalog discovery.
- MV3 background service-worker suspension can interrupt in-memory queues; persisted task/cache state and idempotent resumption require explicit tests.
- Netflix signed timed-text URLs can contain sensitive session data and must not enter logs, fixtures, or persistent storage.
- `chrome.storage.local` is suitable for a personal BYOK MVP but is not a secure place for a vendor-owned key in a public paid extension.
- Hiding native subtitles before the custom overlay is ready could leave the user with no subtitles; restoration is a release gate.
- Manual Netflix verification requires the user's authenticated browser session and suitable titles in the user's region.

---

## Reference review

Implementation details derived from general engineering patterns observed in `keixhuiq/Subtitle-Translate` must be independently written and tested through a clean-room boundary. Do not copy its functions, comments, fixtures, names, or distinctive structure because the reviewed repository has no declared license. See [`docs/research/2026-08-23-subtitle-translate-reference-review.md`](../research/2026-08-23-subtitle-translate-reference-review.md).
