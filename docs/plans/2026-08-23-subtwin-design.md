# SubTwin MVP Design

**Date:** 2026-08-23

**Status:** Approved, amended with provider choice and reference-project findings

**Target:** Personal-use Chrome extension, with clean boundaries for a future paid product

## 1. Product goal

SubTwin adds English–Simplified Chinese bilingual subtitles to Netflix in a desktop browser.

The MVP follows an official-first routing policy:

1. If Netflix provides both English and Simplified Chinese subtitle tracks, SubTwin displays the two official tracks and makes no translation-provider request.
2. Only after Netflix's current-title track catalog is authoritatively known to contain English but not Simplified Chinese may SubTwin use an external provider.
3. The provider must be explicitly selected by the user: experimental no-key Google Free translation or context-aware DeepSeek translation. A fresh installation starts with `provider = unset` and sends subtitle text to neither service.
4. SubTwin never silently switches providers. In particular, a Google Free failure must not consume DeepSeek credit.

The first release is for the repository owner's personal use. It has no account system, payment system, shared backend, analytics, or cloud synchronization. Future commercialization is supported through interfaces rather than prematurely building SaaS infrastructure.

## 2. Scope

### Included in the MVP

- Chrome Manifest V3 extension built with WXT, TypeScript, and React.
- Netflix desktop web player support.
- English source subtitles and Simplified Chinese target subtitles.
- Discovery and parsing of available Netflix timed-text tracks.
- Automatic preference for official Simplified Chinese subtitles.
- Selectable experimental Google Free translation without an API key.
- Selectable context-aware DeepSeek translation when an official target track is absent.
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
    | official                    | external (explicit choice only)
    v                             v
Official Aligner             Selected Provider
    |                         /              \
    |               GoogleFreeProvider   DeepSeekProvider
    |                         \              /
    |                      Translation Cache
    |                             |
    +-----------------------------+
                  |
                  v
           Subtitle Renderer
```

### Main components

- **Subtitle Collector:** Discovers subtitle languages and resources, parses supported timed-text formats, and normalizes all cues to `{ id, start, end, text }`.
- **Language Router:** Waits for an authoritative current-title track catalog, selects the official bilingual path when both English and Simplified Chinese exist, and makes no external request in that mode. When official Chinese is confirmed absent, it routes only to the provider explicitly selected by the user.
- **Official Subtitle Aligner:** Matches cues by time overlap rather than array index, allowing the two languages to use different segmentation.
- **Google Free Translator:** Uses the undocumented no-key Google Translate web endpoint as an experimental, best-effort provider. It translates individual cues quickly but has no guaranteed availability or contextual quality.
- **DeepSeek Translator:** Prioritizes the current playback area, translates contextual batches, validates structured responses, and retries only missing or invalid items.
- **Translation Cache:** Stores completed translations in IndexedDB under keys derived from title/episode identity, source subtitle hash, provider, language pair, and provider contract version; DeepSeek keys additionally include model and prompt version.
- **Subtitle Renderer:** Renders an isolated bilingual overlay and responds to playback, seek, fullscreen, episode transition, and player remount events.
- **Settings UI:** Starts with no external provider selected, then stores the user's explicit provider choice, personal DeepSeek API key, and versioned appearance settings locally. Google Free requires no key.

Netflix-specific discovery is isolated behind a subtitle-source adapter. Translation implementations share a `TranslationProvider` interface. The MVP providers are `GoogleFreeProvider` and `PersonalDeepSeekProvider`; a future paid product can add `GoogleCloudProvider` or `SubTwinCloudProvider` without rewriting subtitle collection, alignment, scheduling, or rendering.

## 4. Subtitle acquisition and routing

The first engineering milestone is a Netflix technical probe. It must establish how the current web player exposes subtitle language metadata and timed-text resources, then capture fixtures for repeatable parser tests.

Routing rules:

1. Wait for the Netflix player and identify the current title or episode.
2. Discover the complete current-title track catalog. Timed-text fragments observed on the network are provisional evidence and cannot by themselves prove that Simplified Chinese is absent.
3. Select English as the source track.
4. If Simplified Chinese is available, fetch/parse both tracks, align them, and enter `official` mode.
5. Only when the catalog is authoritative and Simplified Chinese is absent, parse English and enter the explicitly selected provider mode.
6. If the provider is `unset`, keep English/native subtitles visible, make no external request, and ask the user to choose in the extension UI.
7. In `google-free` mode, translate without a key and label the provider experimental.
8. In `deepseek` mode, verify that a DeepSeek key is configured before scheduling work.
9. Never fall back from one external provider to another automatically.
10. If English is unavailable or collection fails, preserve or restore Netflix's native subtitle behavior.

External scheduling is blocked behind an `authoritativeTrackCatalog` gate. If a later Netflix event invalidates the catalog or reveals an official Simplified Chinese track, SubTwin increments the session generation, aborts and discards queued/in-flight provider work, clears provider-derived text from the overlay, and switches to official alignment. A request already accepted by a remote server cannot be recalled, so the implementation must not treat a partial network-observation window as proof of track absence.

Netflix internals may change. Parsing and discovery code therefore returns typed results and typed failures, avoids leaking internal response shapes into the rest of the app, and keeps captured non-copyright test fixtures minimal and synthetic where possible.

## 5. Official subtitle alignment

Official English and Chinese tracks may not contain the same number of cues. Alignment uses cue time intervals:

- Normalize timestamps to milliseconds.
- Find target cues that overlap each source cue.
- Merge adjacent target cues when several target segments map to one source segment.
- Allow a small timing tolerance for near-touching intervals.
- Prefer maximum overlap when multiple mappings are possible.
- Never fall back to an external provider merely because individual official cues align imperfectly.

The renderer may show a source cue without a target cue when no safe official match exists. This is preferable to displaying unrelated text or silently spending API credit.

## 6. Translation providers and scheduling

The UI displays translations cue by cue. Scheduling is provider-neutral, while request shape is provider-specific.

### Scheduling

- The urgent tier always covers the current cue and approximately five following cues.
- DeepSeek uses a small urgent batch and background batches of approximately 15–25 target cues.
- Google Free translates cues individually because its undocumented endpoint has no reliable structured batch contract.
- A bounded queue keeps translation ahead of playback without flooding the API.
- Global concurrency reserves capacity for urgent work so background pretranslation cannot block the current subtitle.
- Seeking reprioritizes work around the new playback position.
- Previously started background work may finish and populate the cache, but it cannot block urgent work.
- English remains immediately visible while an initial Chinese result is pending.

Every scheduled task carries the episode generation and selected-provider generation. Changing provider, disabling the extension, discovering an official track, or changing episode aborts the old generation, removes its queued work, clears its displayed translations, and rejects late callbacks before rendering or cache writes. Existing cache entries remain isolated by provider and are not deleted merely because the user switches provider.

### DeepSeek prompt contract

Each request includes stable cue IDs, target cues, nearby read-only context, and reliable title/episode metadata when available. The model is instructed to:

- produce natural, concise Simplified Chinese subtitles;
- use surrounding context for pronouns, names, tone, and sentence fragments;
- preserve meaning without adding explanations;
- not merge, split, reorder, or omit requested cue IDs;
- return a strict JSON object/array matching the documented schema.

Thinking mode is disabled for ordinary subtitle translation to reduce latency. The model identifier remains configurable so it can be chosen after real API quality and latency measurements.

### Google Free contract

`GoogleFreeProvider` uses the no-key `translate.googleapis.com/translate_a/single?client=gtx` endpoint with an explicit English source and Simplified Chinese target. This endpoint is not part of the documented Google Cloud Translation API and is therefore treated as experimental:

- it is optional and user-selected;
- it requires no API key;
- it may be rate-limited, change shape, or stop working without notice;
- it receives only the cue text needed for the selected translation task;
- it sends `sl=en`, `tl=zh-CN`, and `dt=t`, encodes text with `URLSearchParams`, and versions its undocumented response parser as `google-free-v1`;
- it starts at no more than two concurrent requests with at least 200 ms between dispatches, does not automatically retry 403 responses, applies bounded backoff to 429/transient failures, and enters a cooldown after repeated rate limits;
- because the cue is placed in a GET query parameter, the settings UI discloses that subtitle text can appear in Google, browser, proxy, or network diagnostic logs even though transport uses HTTPS;
- application logs never contain the query string, full request URL, cue text, or returned subtitle text;
- it does not receive the DeepSeek key or DeepSeek settings;
- failure leaves English visible and reports `google_free_unavailable`;
- failure never triggers a DeepSeek request automatically.

For a future public or paid release, use the documented Google Cloud Translation API or another supported provider rather than relying on this endpoint.

### Response validation

Common validation rejects empty output, implausibly long output, suspiciously unchanged English, stale generation IDs, and mismatched provider/task identities. It classifies authentication, balance, rate-limit, timeout, malformed-response, experimental-provider-unavailable, and provider errors for the UI.

DeepSeek validation parses strict JSON, verifies that every returned cue ID belongs to the request, detects missing/duplicate IDs and explanatory output, and retries only invalid or missing cues with a bounded retry count. Google Free validation defensively concatenates only translated string segments from the expected nested-array shape; an empty or changed shape is a typed provider-contract failure and never causes an unbounded retry or DeepSeek fallback.

## 7. Storage and security

- The DeepSeek API key is entered through the extension settings UI.
- It and versioned settings are stored only in `chrome.storage.local` for the personal MVP; a new installation has `provider = unset`.
- It is never committed, placed in source `.env` files, emitted to logs, included in diagnostics, or embedded into distributed builds.
- The key is read and used only by the background service worker; content and page-world scripts never receive it.
- Provider choice is explicit and stored separately from credentials.
- Subtitle text is sent only to Netflix and the selected external provider; the UI must disclose which provider receives it.
- Internal target language `zh-Hans` maps to Google request language `zh-CN` only inside `GoogleFreeProvider`; provider-specific language codes do not leak into subtitle-domain types.
- Full Google query URLs and Netflix signed timed-text URLs are never logged, included in diagnostics, or persisted. Only sanitized host/path categories, status codes, and typed error codes may be recorded.
- Appearance settings use a versioned schema and migration functions.
- Translation cache entries do not contain account credentials.
- Translation cache uses IndexedDB, is persistent across browser restarts, provider-separated, size-bounded, and clearable for the current episode or globally. It contains subtitle text but never credentials.

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
- **No provider selected:** keep English/native subtitles visible, make zero external requests, and show a one-time provider-choice status.
- **Official Chinese track present:** use it and make zero external provider calls.
- **DeepSeek selected with no key:** keep English visible and show a configuration status in the extension UI.
- **Google Free unavailable:** keep English visible, show an experimental-provider status, and do not switch to DeepSeek automatically.
- **Authentication or balance error:** stop new AI work, keep English visible, and surface one persistent status rather than repeated popups.
- **Rate limit or timeout:** retry with bounded exponential backoff.
- **Malformed DeepSeek response:** retry only affected cues within the strict retry limit.
- **Malformed Google Free response:** mark the experimental provider unavailable for the task; do not loop or cross-fallback.
- **Provider changed or official track discovered:** abort the old generation and ignore every late result.
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
- Authoritative track-catalog gating and first-run `provider = unset` privacy behavior.
- Provider-switch generation disposal and stale-result rejection.
- Appearance-setting migrations.
- TTML timing parameters (`tickRate`, `frameRate`, and `frameRateMultiplier`) and the rule that frame timing is never hard-coded to 24 fps.

### Provider contract tests

Mock DeepSeek responses for success, invalid JSON, missing IDs, duplicate IDs, empty output, authentication failure, insufficient balance, rate limiting, timeout, and transient server errors. Mock Google Free success, multi-segment arrays, malformed/changed arrays, empty output, 403/429 responses, timeouts, endpoint unavailability, `en` to `zh-CN` parameter mapping, and dispatch throttling. Assert the complete call matrix: `unset` calls neither provider; Google mode and Google failures make zero DeepSeek calls; DeepSeek mode and DeepSeek failures make zero Google calls; switching provider aborts/ignores the old generation. Diagnostics must never contain Google query strings or subtitle text.

### Manual Netflix verification

- A title with official English and Simplified Chinese tracks.
- A title with English but no Simplified Chinese track.
- Initial playback, pause/resume, seek, fullscreen, episode transition, and player remount.
- First-run provider choice, provider switching during in-flight work, invalid DeepSeek key, no key, Google Free failure, offline state, and rate limiting.
- Style changes and persistence.

## 12. MVP acceptance criteria

- When official English and Simplified Chinese tracks exist, total external provider request count is exactly zero.
- Before authoritative track discovery or explicit provider selection, total external provider request count is exactly zero.
- When only English exists, Simplified Chinese begins appearing within a few seconds under ordinary API/network conditions and remains ahead of playback after warm-up.
- Google Free and DeepSeek are selectable, provider identity is visible, and switching providers cannot render/cache late results or reuse another provider's cache entries.
- A Google Free failure makes exactly zero DeepSeek requests.
- A DeepSeek failure makes exactly zero Google Free requests; selecting either provider makes zero calls to the unselected provider.
- Translation results do not shift between cue IDs or disappear silently.
- Replaying a translated episode reads from the local cache.
- Extension failures do not break playback or permanently hide native subtitles.
- Practical appearance settings update live and persist after browser restart.
- The DeepSeek key is absent from Git history, application logs, source/build configuration, page-world messages, and content-script messages.
- A manually reviewed DeepSeek benchmark checks names, pronouns, tone, fragments, and cross-cue context, not merely the presence of Chinese text. A separate Google Free benchmark measures best-effort single-cue readability and latency without implying equal contextual accuracy.

## 13. Reference implementation lessons

The `keixhuiq/Subtitle-Translate` repository validates several behaviors worth independently reimplementing: first-chunk subtitle sniffing, fetch/XHR interception, CDN range URL canonicalization, provisional/confirmed track lifecycle, generation-based disposal, bounded urgent/bulk scheduling, native subtitle DOM synchronization, and restoring native subtitles when custom rendering fails.

SubTwin intentionally differs in important ways:

- official Simplified Chinese remains the highest-priority zero-provider path;
- DeepSeek translates structured contextual batches instead of one API call per cue;
- provider credentials remain background-only;
- translation cache persists across browser restarts and is separated by provider;
- Netflix, provider, parser, scheduler, storage, and renderer code remain modular and tested;
- no source code is copied because the reference repository has no declared license.

See [`docs/research/2026-08-23-subtitle-translate-reference-review.md`](../research/2026-08-23-subtitle-translate-reference-review.md) for the detailed review and source links.

## 14. Future commercialization boundary

A paid release may add authentication, a hosted translation proxy, metering, subscriptions, analytics with explicit consent, remote configuration, additional sites, and additional language pairs. The experimental no-key Google endpoint is not a commercial dependency; a public release must either retain it as clearly labeled best-effort functionality after policy review or replace it with the documented Google Cloud Translation API. Those features are intentionally outside the MVP. The current adapter/provider boundaries and versioned settings/cache schemas are the only forward-looking infrastructure included now.
