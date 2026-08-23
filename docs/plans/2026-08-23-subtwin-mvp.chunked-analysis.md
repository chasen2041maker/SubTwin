# Chunked Execution Analysis

**Source Plan:** `docs/plans/2026-08-23-subtwin-mvp.md`  
**Generated:** 2026-08-23T18:00:00+08:00  
**Status:** PENDING_APPROVAL

---

## Parsed Chunks

### chunk-01: Extension scaffold and shared contracts

**Skill:** frontend-dev  
**Complexity:** COMPLEX  
**Dependencies:** none

**Files:**

- creates: `package.json`, `pnpm-lock.yaml`, `wxt.config.ts`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `entrypoints/background.ts`, `src/shared/result.ts`, `src/shared/messages.ts`, `README.md`
- modifies: none

**Acceptance Criteria:**

- [ ] Test, type-check, and production build scripts pass.
- [ ] Output is a valid MV3 extension without secrets.
- [ ] Permissions follow least privilege.

### chunk-02: Subtitle domain, parsers, and official-track alignment

**Skill:** frontend-dev  
**Complexity:** COMPLEX  
**Dependencies:** chunk-01

**Files:**

- creates: `src/subtitles/types.ts`, `src/subtitles/normalize.ts`, `src/subtitles/ttml.ts`, `src/subtitles/webvtt.ts`, `src/subtitles/align.ts`, subtitle fixtures, parser/alignment tests
- modifies: none

**Acceptance Criteria:**

- [ ] TTML and WebVTT normalize deterministically.
- [ ] Time-based alignment covers segmentation edge cases.
- [ ] Malformed input returns typed failures.
- [ ] Official alignment is independent from translation.

### chunk-03: Netflix subtitle-source adapter and technical probe

**Skill:** frontend-dev  
**Complexity:** COMPLEX  
**Dependencies:** chunk-01, chunk-02

**Files:**

- creates: subtitle-source contract, Netflix types/adapter, main-world probe, isolated content entrypoint, adapter tests
- modifies: `src/shared/messages.ts`, `wxt.config.ts`

**Acceptance Criteria:**

- [ ] Manual probe enumerates relevant tracks.
- [ ] Only sanitized timed-text data crosses the bridge.
- [ ] Episode/remount lifecycle is disposable.
- [ ] Unsupported payloads preserve native behavior.

### chunk-04: DeepSeek provider, validation, scheduling, and cache

**Skill:** frontend-dev  
**Complexity:** COMPLEX  
**Dependencies:** chunk-01, chunk-02

**Files:**

- creates: translation contracts, provider, prompt, validator, scheduler, cache, and related tests
- modifies: `entrypoints/background.ts`, `src/shared/messages.ts`

**Acceptance Criteria:**

- [ ] Provider error matrix is covered by contract tests.
- [ ] Scheduling prioritizes playback and avoids duplicate work.
- [ ] Partial retry is bounded and targeted.
- [ ] Cache prevents repeat API calls.
- [ ] Secrets cannot leak across page/log/test boundaries.

### chunk-05: Versioned settings, popup, options, and subtitle overlay

**Skill:** frontend-dev + frontend-design + react-best-practices  
**Complexity:** COMPLEX  
**Dependencies:** chunk-01, chunk-02

**Files:**

- creates: storage schema/settings, React overlay and CSS, popup/options entrypoints, settings/renderer tests
- modifies: none

**Acceptance Criteria:**

- [ ] Practical appearance settings preview and persist.
- [ ] Schema migration is covered.
- [ ] Overlay is isolated and pointer-transparent.
- [ ] Key presentation and diagnostics do not leak secrets.
- [ ] Native subtitle restoration is reliable.

### chunk-06: Routing controller, integration, and release verification

**Skill:** frontend-dev + react-best-practices  
**Complexity:** COMPLEX  
**Dependencies:** chunk-03, chunk-04, chunk-05

**Files:**

- creates: session controller, language router, status model, integration tests, manual verification guide
- modifies: content/background/popup entrypoints and `README.md`

**Acceptance Criteria:**

- [ ] Official bilingual mode makes zero provider calls.
- [ ] AI mode prioritizes, warms, and caches translations.
- [ ] Failures preserve playback/subtitles.
- [ ] Player lifecycle does not leak overlays/listeners.
- [ ] Automated and manual release checks pass.

---

## Dependency Graph

```text
chunk-01
   |
   v
chunk-02
   |--------------------|
   |          |         |
   v          v         v
chunk-03   chunk-04   chunk-05
   |          |         |
   |----------|---------|
              |
              v
          chunk-06
```

---

## Execution Order

| Step | Chunk | Skill | Complexity | Depends On |
|------|-------|-------|------------|------------|
| 1 | chunk-01 | frontend-dev | COMPLEX | - |
| 2 | chunk-02 | frontend-dev | COMPLEX | chunk-01 |
| 3 | chunk-03 | frontend-dev | COMPLEX | chunk-01, chunk-02 |
| 4 | chunk-04 | frontend-dev | COMPLEX | chunk-01, chunk-02 |
| 5 | chunk-05 | frontend-dev + frontend-design + react-best-practices | COMPLEX | chunk-01, chunk-02 |
| 6 | chunk-06 | frontend-dev + react-best-practices | COMPLEX | chunk-03, chunk-04, chunk-05 |

Chunks 03, 04, and 05 are independent after chunk-02 and may be developed in parallel only if execution tooling and repository coordination explicitly permit it. The default execution order remains sequential to keep changes reviewable.

---

## Review Strategy

| Chunk | Complexity | Review Type |
|-------|------------|-------------|
| chunk-01 | COMPLEX | 2-stage: spec, then quality/security |
| chunk-02 | COMPLEX | 2-stage: fixtures/spec, then parser/alignment quality |
| chunk-03 | COMPLEX | 2-stage: Netflix behavior/spec, then lifecycle/privacy quality |
| chunk-04 | COMPLEX | 2-stage: provider/scheduler spec, then security/error quality |
| chunk-05 | COMPLEX | 2-stage: settings/UI spec, then accessibility/React quality |
| chunk-06 | COMPLEX | 2-stage: end-to-end spec, then release verification |

---

## User Decision Required

- [ ] Approve chunk breakdown.
- [ ] Approve execution order.
- [ ] Confirm readiness to execute.
