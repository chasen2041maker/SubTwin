# SubTwin MVP Implementation Plan

**Goal:** Build a personal-use Chrome extension that displays official English/Simplified Chinese Netflix subtitles when available and otherwise generates context-aware Simplified Chinese subtitles through the user's DeepSeek API key.

**Architecture:** A WXT Manifest V3 extension separates Netflix page instrumentation, normalized subtitle-domain logic, a background translation service, local storage, and an isolated React subtitle overlay. Official tracks always take precedence; DeepSeek is reachable only through the AI routing branch.

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

Initialize a WXT React/TypeScript Manifest V3 project targeting Chrome. Configure scripts for development, type-checking, unit tests, production build, and zipped release output. Request only Netflix page access, DeepSeek API host access, and storage permissions. Define typed `Result` and cross-context message envelopes before feature code. Document local loading and the rule that API keys never enter source files or Git.

**Acceptance Criteria:**

- [ ] `pnpm test`, `pnpm typecheck`, and `pnpm build` complete successfully.
- [ ] The unpacked build contains a valid Manifest V3 background service worker and no embedded API key.
- [ ] Extension permissions are limited to storage, Netflix pages, and the DeepSeek API host.

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

Define normalized track/cue types with millisecond timestamps and language metadata. Implement small, deterministic TTML and WebVTT parsers for the formats observed by the technical probe, keeping format-specific details behind parser functions. Implement overlap-based official-track alignment with tolerance, adjacent-cue merging, deterministic tie-breaking, and explicit gaps instead of index-based pairing.

**Acceptance Criteria:**

- [ ] TTML and WebVTT fixtures normalize to stable cue IDs, timestamps, and plain text.
- [ ] Alignment handles one-to-one, one-to-many, many-to-one, near-touching, and no-match fixtures.
- [ ] Malformed subtitle input returns typed errors without throwing across extension boundaries.
- [ ] Alignment never invokes or references a translation provider.

**Dependencies:** chunk-01

### chunk-03: Netflix subtitle-source adapter and technical probe

**Files:**

- Create: `src/subtitles/source.ts`
- Create: `src/netflix/types.ts`
- Create: `src/netflix/adapter.ts`
- Create: `entrypoints/netflix-main-world.content.ts`
- Create: `entrypoints/netflix.content/index.tsx`
- Create: `tests/netflix/adapter.test.ts`
- Modify: `src/shared/messages.ts`
- Modify: `wxt.config.ts`

**Changes:**

Add a main-world probe that observes only relevant player metadata and timed-text network responses, then sends sanitized data to the isolated content script through a narrow validated message protocol. Build a Netflix adapter that discovers title/episode identity, identifies English and Simplified Chinese track candidates, retrieves timed text using the active browser session, and delegates parsing to chunk-02. Model player remount, episode change, missing track, unsupported payload, and adapter-version mismatch as typed events/errors. Keep all Netflix response shapes inside `src/netflix`.

**Acceptance Criteria:**

- [ ] A logged-in manual probe can enumerate English and Simplified Chinese subtitle availability for a selected Netflix title.
- [ ] Timed-text data reaches the isolated content script as normalized tracks without exposing cookies, authorization headers, or media/DRM payloads.
- [ ] Episode changes and player remounts produce a new session identity and dispose stale listeners.
- [ ] Unsupported Netflix payloads restore/preserve native subtitle behavior and emit a non-sensitive diagnostic code.

**Dependencies:** chunk-01, chunk-02

### chunk-04: DeepSeek provider, validation, scheduling, and cache

**Files:**

- Create: `src/translation/types.ts`
- Create: `src/translation/provider.ts`
- Create: `src/translation/deepseek.ts`
- Create: `src/translation/prompt.ts`
- Create: `src/translation/validate.ts`
- Create: `src/translation/scheduler.ts`
- Create: `src/translation/cache.ts`
- Create: `tests/translation/deepseek.test.ts`
- Create: `tests/translation/scheduler.test.ts`
- Create: `tests/translation/cache.test.ts`
- Modify: `entrypoints/background.ts`
- Modify: `src/shared/messages.ts`

**Changes:**

Define a provider-neutral translation contract and implement `PersonalDeepSeekProvider` in the background worker. Send strict JSON chat-completion requests with thinking disabled, stable cue IDs, target cues, read-only surrounding context, and a versioned translation prompt. Validate IDs, duplicates, missing/empty translations, explanatory output, suspicious untranslated content, and excessive length. Build a bounded priority scheduler with an urgent current-plus-next-five batch, 15–25 cue background batches, seek reprioritization, partial retry, and bounded exponential backoff. Cache valid cue translations by episode/track hash/language/model/prompt version.

**Acceptance Criteria:**

- [ ] Provider contract tests cover success, invalid JSON, missing/duplicate IDs, empty output, 401, insufficient balance, 429, timeout, and transient server errors.
- [ ] Seeking promotes the new playback neighborhood ahead of queued background work without duplicating completed translations.
- [ ] Only invalid or missing cues are selected for retry, with a strict retry limit.
- [ ] Repeated requests for the same cache key return locally without an API call.
- [ ] API keys and authorization headers never appear in logs, errors, fixtures, or message payloads sent to the page.

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

Implement versioned local settings for enablement, DeepSeek key, model, and the approved practical appearance controls. Build a small popup showing current mode/status and an options page with key testing, live subtitle preview, per-language visibility/color/size/weight, ordering, spacing, vertical offset, background opacity, shadow, and cache clearing. Create a pointer-transparent Shadow DOM overlay whose styles are driven entirely by settings and which can be mounted/unmounted without leaving Netflix subtitles hidden.

**Acceptance Criteria:**

- [ ] Appearance changes update the preview immediately and survive browser restart.
- [ ] Settings migrations preserve valid prior values and replace invalid values with defaults.
- [ ] The overlay renders English and Chinese independently, supports order changes, and does not intercept player controls.
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

Wire collection, routing, official alignment, AI scheduling, cache, status, and rendering into a disposable per-episode session controller. Encode the invariant that an available official Simplified Chinese track produces zero DeepSeek calls. Handle missing English, missing key, authentication/balance failure, rate limiting, offline mode, malformed responses, adapter failure, seek, fullscreen, player remount, and episode transition. Add a manual verification matrix and local installation instructions. Run build, unit tests, a packaged-extension inspection, and logged-in Netflix smoke tests.

**Acceptance Criteria:**

- [ ] Official English plus Simplified Chinese routes directly to alignment and makes exactly zero provider calls.
- [ ] English-only content prioritizes initial/current translations, warms the background queue, and reuses cached translations on replay.
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
- `chrome.storage.local` is suitable for a personal BYOK MVP but is not a secure place for a vendor-owned key in a public paid extension.
- Hiding native subtitles before the custom overlay is ready could leave the user with no subtitles; restoration is a release gate.
- Manual Netflix verification requires the user's authenticated browser session and suitable titles in the user's region.

