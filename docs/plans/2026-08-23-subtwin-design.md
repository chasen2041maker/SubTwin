# SubTwin MVP Design

**Date:** 2026-08-23

**Status:** Approved
**Target:** Personal-use Chrome extension, with clean boundaries for a future paid product

## 1. Product goal

SubTwin adds English–Simplified Chinese bilingual subtitles to Netflix in a desktop browser.

The MVP follows two automatic paths:

1. If Netflix provides both English and Simplified Chinese subtitle tracks, SubTwin displays the two official tracks and makes no DeepSeek request.
2. If Netflix provides English but not Simplified Chinese, SubTwin translates the English track through the user's DeepSeek API key, caches the result locally, and displays both languages.

The first release is for the repository owner's personal use. It has no account system, payment system, shared backend, analytics, or cloud synchronization. Future commercialization is supported through interfaces rather than prematurely building SaaS infrastructure.

## 2. Scope

### Included in the MVP

- Chrome Manifest V3 extension built with WXT, TypeScript, and React.
- Netflix desktop web player support.
- English source subtitles and Simplified Chinese target subtitles.
- Discovery and parsing of available Netflix timed-text tracks.
- Automatic preference for official Simplified Chinese subtitles.
- Context-aware DeepSeek translation when an official target track is absent.
- Local translation cache.
- Bilingual overlay synchronized to video playback.
- Practical subtitle appearance settings with live preview.
- Clear, non-disruptive error states.
- Unit, contract, and manual Netflix verification.

### Excluded from the MVP

- Other streaming sites.
- Arbitrary source/target language pairs.
- Mobile and TV apps.
- Native picture-in-picture subtitle support.
- Accounts, subscriptions, payments, quotas, or a hosted translation proxy.
- Subtitle download or redistribution.
- Vocabulary learning, word lookup, or study notes.

## 3. Architecture

```text
Netflix player
    |
    v
Subtitle Collector
    |
    v
Language Router
    |-------------------------------|
    |                               |
    v                               v
Official Subtitle Aligner     DeepSeek Translator
    |                               |
    |                         Translation Cache
    |                               |
    |-------------------------------|
                    |
                    v
             Subtitle Renderer
```

### Main components

- **Subtitle Collector:** Discovers subtitle languages and resources, parses supported timed-text formats, and normalizes all cues to `{ id, start, end, text }`.
- **Language Router:** Selects the official bilingual path when both English and Simplified Chinese exist. It must not call DeepSeek in this mode.
- **Official Subtitle Aligner:** Matches cues by time overlap rather than array index, allowing the two languages to use different segmentation.
- **DeepSeek Translator:** Prioritizes the current playback area, translates contextual batches, validates structured responses, and retries only missing or invalid items.
- **Translation Cache:** Stores completed translations under keys derived from title/episode identity, source subtitle hash, language pair, model, and prompt version.
- **Subtitle Renderer:** Renders an isolated bilingual overlay and responds to playback, seek, fullscreen, episode transition, and player remount events.
- **Settings UI:** Stores the personal DeepSeek API key and versioned appearance settings locally.

Netflix-specific discovery is isolated behind a subtitle-source adapter. The translation implementation is isolated behind a `TranslationProvider` interface. The MVP provider is `PersonalDeepSeekProvider`; a future paid product can add `SubTwinCloudProvider` without rewriting subtitle collection, alignment, scheduling, or rendering.

## 4. Subtitle acquisition and routing

The first engineering milestone is a Netflix technical probe. It must establish how the current web player exposes subtitle language metadata and timed-text resources, then capture fixtures for repeatable parser tests.

Routing rules:

1. Wait for the Netflix player and identify the current title or episode.
2. Discover available subtitle tracks.
3. Select English as the source track.
4. If Simplified Chinese is available, fetch/parse both tracks, align them, and enter `official` mode.
5. Otherwise, parse English, verify that a DeepSeek key is configured, and enter `ai` mode.
6. If English is unavailable or collection fails, preserve or restore Netflix's native subtitle behavior.

Netflix internals may change. Parsing and discovery code therefore returns typed results and typed failures, avoids leaking internal response shapes into the rest of the app, and keeps captured non-copyright test fixtures minimal and synthetic where possible.

## 5. Official subtitle alignment

Official English and Chinese tracks may not contain the same number of cues. Alignment uses cue time intervals:

- Normalize timestamps to milliseconds.
- Find target cues that overlap each source cue.
- Merge adjacent target cues when several target segments map to one source segment.
- Allow a small timing tolerance for near-touching intervals.
- Prefer maximum overlap when multiple mappings are possible.
- Never fall back to DeepSeek merely because individual official cues align imperfectly.

The renderer may show a source cue without a target cue when no safe official match exists. This is preferable to displaying unrelated text or silently spending API credit.

## 6. DeepSeek translation pipeline

The UI displays translations cue by cue, but translation is contextual and batched.

### Scheduling

- The first urgent batch contains the current cue and approximately five following cues.
- Background batches contain approximately 15–25 target cues.
- A bounded queue keeps translation ahead of playback without flooding the API.
- Seeking reprioritizes work around the new playback position.
- Previously started background work may finish and populate the cache, but it cannot block urgent work.
- English remains immediately visible while an initial Chinese result is pending.

### Prompt contract

Each request includes stable cue IDs, target cues, nearby read-only context, and reliable title/episode metadata when available. The model is instructed to:

- produce natural, concise Simplified Chinese subtitles;
- use surrounding context for pronouns, names, tone, and sentence fragments;
- preserve meaning without adding explanations;
- not merge, split, reorder, or omit requested cue IDs;
- return a strict JSON object/array matching the documented schema.

Thinking mode is disabled for ordinary subtitle translation to reduce latency. The model identifier remains configurable so it can be chosen after real API quality and latency measurements.

### Response validation

- Parse JSON defensively.
- Verify every returned cue ID belongs to the request.
- Detect missing, duplicate, empty, or explanatory responses.
- Flag suspiciously untranslated English and excessively long output.
- Retry only invalid or missing cues with a bounded retry count.
- Classify authentication, balance, rate-limit, timeout, malformed-response, and provider errors for the UI.

## 7. Storage and security

- The DeepSeek API key is entered through the extension settings UI.
- It is stored only in extension-local browser storage for the personal MVP.
- It is never committed, placed in source `.env` files, emitted to logs, included in diagnostics, or embedded into distributed builds.
- Appearance settings use a versioned schema and migration functions.
- Translation cache entries do not contain account credentials.
- Cache size is bounded and can be cleared for the current episode or globally.

If SubTwin becomes a paid public product, the owner's provider key must move behind an authenticated backend with quotas and abuse protection. It must never be shipped inside the extension.

## 8. Rendering and customization

SubTwin hides Netflix's native subtitle presentation only after the custom overlay is ready. If initialization fails, native subtitles are preserved or restored.

The overlay uses Shadow DOM to isolate its styles from Netflix and is non-interactive over the video (`pointer-events: none`). It supports fullscreen and remounts safely when Netflix changes routes or replaces the player.

The default theme shows English above Simplified Chinese, but no visual value is hard-coded into rendering logic. The practical settings tier includes:

- per-language visibility;
- per-language text color;
- per-language font size;
- per-language font weight;
- source-first or translation-first ordering;
- line spacing;
- vertical offset;
- background opacity;
- text shadow toggle.

Changes preview immediately and persist across browser restarts. Future settings can be added through schema migration without invalidating existing preferences.

## 9. Error handling

The extension must never prevent normal Netflix playback.

- **No English track:** leave Netflix untouched and report that the title is unsupported.
- **Official Chinese track present:** use it and make zero DeepSeek calls.
- **No official Chinese and no key:** keep English visible and show a configuration status in the extension UI.
- **Authentication or balance error:** stop new AI work, keep English visible, and surface one persistent status rather than repeated popups.
- **Rate limit or timeout:** retry with bounded exponential backoff.
- **Malformed provider response:** retry only affected cues.
- **Netflix adapter failure:** remove the custom overlay and restore native subtitles.
- **Official alignment gap:** show the available official cue mapping; do not silently switch to AI.

Logs contain typed error codes and non-sensitive context only.

## 10. Technology and project structure

**Stack:** WXT, TypeScript, React, plain CSS/CSS variables, Vitest, Chrome Manifest V3.

```text
entrypoints/
  background.ts
  netflix.content/
  netflix-main-world.content.ts
  popup/
  options/
src/
  subtitles/
  translation/
  renderer/
  storage/
  messaging/
  shared/
tests/
```

React is used for the popup, options UI, and overlay. Subtitle parsing, alignment, caching, and translation scheduling remain pure TypeScript modules with no React dependency.

## 11. Testing strategy

### Unit tests

- TTML/WebVTT parsing and normalization.
- Cue overlap alignment and segmentation differences.
- Translation batching and seek reprioritization.
- Structured response validation and partial retry selection.
- Cache key derivation and invalidation.
- Appearance-setting migrations.

### Provider contract tests

Mock DeepSeek responses for success, invalid JSON, missing IDs, duplicate IDs, empty output, authentication failure, insufficient balance, rate limiting, timeout, and transient server errors.

### Manual Netflix verification

- A title with official English and Simplified Chinese tracks.
- A title with English but no Simplified Chinese track.
- Initial playback, pause/resume, seek, fullscreen, episode transition, and player remount.
- Invalid key, no key, offline state, and rate limiting.
- Style changes and persistence.

## 12. MVP acceptance criteria

- When official English and Simplified Chinese tracks exist, DeepSeek request count is exactly zero.
- When only English exists, Simplified Chinese begins appearing within a few seconds under ordinary API/network conditions and remains ahead of playback after warm-up.
- Translation results do not shift between cue IDs or disappear silently.
- Replaying a translated episode reads from the local cache.
- Extension failures do not break playback or permanently hide native subtitles.
- Practical appearance settings update live and persist after browser restart.
- The DeepSeek key is absent from Git history, application logs, and source/build configuration.
- A manually reviewed benchmark checks names, pronouns, tone, fragments, and cross-cue context, not merely the presence of Chinese text.

## 13. Future commercialization boundary

A paid release may add authentication, a hosted translation proxy, metering, subscriptions, analytics with explicit consent, remote configuration, additional sites, and additional language pairs. Those features are intentionally outside the MVP. The current adapter/provider boundaries and versioned settings/cache schemas are the only forward-looking infrastructure included now.
