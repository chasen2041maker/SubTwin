# SubTwin

SubTwin is a personal-use Chrome extension for English–Simplified Chinese
Netflix subtitles. This repository currently contains the WXT/React/TypeScript
Manifest V3 foundation and its versioned cross-context contracts; subtitle
discovery and translation are intentionally not implemented in this scaffold.

## Requirements

- Node.js 22.12 or newer
- pnpm 10 or newer (the repository pins pnpm 11.19.0)
- A Chromium-based browser for local loading

Install dependencies and generate WXT's local types:

```sh
pnpm install
```

Run the extension in WXT's Chrome development profile:

```sh
pnpm dev
```

Run the verification commands:

```sh
pnpm test
pnpm typecheck
pnpm build
```

## Load an unpacked production build

1. Run `pnpm build`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose `.output/chrome-mv3` from this
   repository.
5. Confirm the generated manifest reports Manifest V3 and a background service
   worker.

Use `pnpm zip` to build a distributable Chrome MV3 archive, or `pnpm release`
to run tests, type-checking, and archive creation together. Release archives are
written beneath `.output` and are not committed.

## Privacy and provider policy

SubTwin is official-first. Once subtitle discovery is implemented, an available
official English and Simplified Chinese pair must be used without contacting an
external translation provider. External translation remains locked until the
current title's track catalog is authoritative, Simplified Chinese is confirmed
absent, and the user explicitly chooses a provider.

A fresh installation has `provider = unset`. In that state, subtitle text is
sent to neither Google nor DeepSeek. SubTwin never silently switches providers;
a failure from one provider must not call the other.

The no-key Google Free option is experimental. It relies on an undocumented
Google endpoint, can be rate-limited or stop working, and sends cue text in a
GET query that may appear in Google, browser, proxy, or network diagnostic logs.
It must be labeled experimental wherever it is offered. It is not the supported
Google Cloud Translation API.

DeepSeek is bring-your-own-key. API keys must be entered only through the future
extension settings UI and stored locally for background-worker use. Keys must
never be placed in source files, `.env` files, Git, logs, diagnostics, builds,
or page/content-script messages. The ignored secret-file patterns are only
defense in depth; they are not supported configuration paths.

## Permissions

The production manifest requests only:

- `storage`
- `https://www.netflix.com/*`
- `https://api.deepseek.com/*`
- `https://translate.googleapis.com/*`

There are no optional host permissions and no broad origin patterns. No Netflix
timed-text CDN origin is requested: a future technical probe must supply evidence
before the smallest necessary Netflix-owned host pattern can be considered.
This scaffold makes no assumption about Netflix private APIs or timed-text URLs.

## Shared contracts

`src/shared/result.ts` defines a discriminated `Result` contract with typed,
JSON-safe errors. `src/shared/messages.ts` defines protocol-versioned envelopes
and validates unknown values at extension boundaries. The background service
worker currently handles only a typed health-check message, providing a real
cross-context integration point without implementing later subtitle features.

## License

This personal repository is unlicensed (`UNLICENSED`).
