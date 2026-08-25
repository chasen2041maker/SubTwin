import { describe, expect, it } from 'vitest';

import {
  bufferNetflixTimedTextPayload,
  bufferEarlyCatalogPayload,
  createNetflixContentSession,
  type NetflixContentRestartReason,
  type NetflixContentSessionState,
} from '../../src/app/netflix-content-session';
import type {
  ProviderNeutralTaskClient,
  SessionCancellationReason,
  SessionOverlaySink,
  SessionStatusSink,
  SubtitleSessionTick,
  SubtitleSessionTickSource,
  TranslationTaskCallbacks,
} from '../../src/app/session-controller';
import type { NetflixBridgePayload } from '../../src/netflix/bridge';
import type { NormalizedActiveCueState } from '../../src/renderer/SubtitleOverlay';
import {
  DEFAULT_SETTINGS,
  type RuntimeSettingsState,
} from '../../src/storage/schema';
import type {
  ScheduledTranslationTask,
  SchedulerGeneration,
} from '../../src/translation/scheduler';

describe('Netflix isolated content session', () => {
  it('surfaces a sanitized Netflix-unavailable error when the MAIN-world downloader cannot produce subtitle bodies', () => {
    const harness = createHarness(settings('unset', false));

    harness.session.handlePayload({
      type: 'diagnostic',
      code: 'display_unavailable',
    });

    expect(harness.status.values.at(-1)).toEqual({
      mode: 'error',
      code: 'netflix_unavailable',
    });
  });

  it('buffers the bounded set of timed-text resources needed for eight tracks per language category', () => {
    let payloads: Extract<NetflixBridgePayload, { type: 'timed-text' }>[] = [];
    for (let index = 0; index < 16; index += 1) {
      payloads = bufferNetflixTimedTextPayload(payloads, timedText(
        'buffered-title',
        `tt_${String(index).padStart(16, '0')}`,
        `track-${index}`,
        index < 8 ? 'en' : 'zh-Hans',
        `Cue ${index}`,
      ));
    }

    expect(payloads).toHaveLength(16);
    expect(new Set(payloads.map(({ trackId }) => trackId)).size).toBe(16);
  });

  it('keeps an authoritative early catalog when foreign provisional catalogs interleave', () => {
    let payloads: NetflixBridgePayload[] = [];

    payloads = bufferEarlyCatalogPayload(payloads, catalog('title-a', 'authoritative', [
      descriptor('a-en', 'en'),
    ]), 2);
    payloads = bufferEarlyCatalogPayload(payloads, catalog('title-b', 'provisional', [
      descriptor('b-en', 'en'),
    ]), 2);
    payloads = bufferEarlyCatalogPayload(payloads, catalog('title-a', 'provisional', [
      descriptor('a-preview', 'en'),
    ]), 2);

    expect(payloads.filter(({ type }) => type === 'catalog')).toEqual([
      catalog('title-a', 'authoritative', [descriptor('a-en', 'en')]),
      catalog('title-b', 'provisional', [descriptor('b-en', 'en')]),
    ]);
  });

  it('aligns authoritative official English and Simplified Chinese with zero provider calls', () => {
    const harness = createHarness(settings('unset', true));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en-US'),
      descriptor('zh-main', 'zh-CN'),
    ]));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en-US',
      'Hello',
    ));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_fedcba9876543210',
      'zh-main',
      'zh-CN',
      '你好',
    ));

    harness.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });

    expect(harness.diagnostics.map(({ code }) => code)).toEqual([
      'timed_text_received',
      'timed_text_accepted',
      'timed_text_received',
      'timed_text_accepted',
    ]);
    expect(harness.tasks.scheduled).toHaveLength(0);
    expect(harness.overlay.last()).toEqual({ english: 'Hello', chinese: '你好' });
    expect(harness.status.values.at(-1)).toEqual({ mode: 'official' });
  });

  it('uses an explicitly selected provider with an authoritative English and Chinese catalog', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-explicit', 'authoritative', [
      descriptor('en-main', 'en-US'),
      descriptor('zh-main', 'zh-CN'),
    ]));
    harness.session.handlePayload(timedText(
      'title-explicit',
      'tt_0123456789abcdef',
      'en-main',
      'en-US',
      'Translate this explicitly',
    ));
    harness.session.handlePayload(timedText(
      'title-explicit',
      'tt_fedcba9876543210',
      'zh-main',
      'zh-CN',
      '官方中文不应接管',
    ));

    harness.ticks.emit({ visibleText: 'Translate this explicitly', currentTimeMs: 500 });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(({ task }) => task.provider === 'google-free'))
      .toBe(true);
    expect(harness.status.values.at(-1)).toEqual({ mode: 'google-free' });
  });

  it('translates visible native English when Netflix does not expose a timed-text body', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('native-fallback-title', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));

    harness.ticks.emit({
      visibleText: 'A visible subtitle without a downloadable body',
      currentTimeMs: 2_000,
    });

    expect(harness.tasks.scheduled.some(({ task }) =>
      task.provider === 'google-free' &&
      task.cues.some(({ text }) => text ===
        'A visible subtitle without a downloadable body'))).toBe(true);
  });

  it('translates visible native English when subtitle and CC catalogs are both present without bodies', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('native-multi-track-title', 'authoritative', [
      descriptor('en-subtitle', 'en', 'subtitle'),
      descriptor('en-cc', 'en', 'closed-caption'),
    ]));

    harness.ticks.emit({
      visibleText: 'Translate the English line that is visibly selected',
      currentTimeMs: 2_000,
    });

    expect(harness.tasks.scheduled.some(({ task }) =>
      task.provider === 'google-free' &&
      task.cues.some(({ text }) => text ===
        'Translate the English line that is visibly selected'))).toBe(true);
  });

  it('keeps discovery and provider-unset catalogs at exactly zero external work', () => {
    const discovering = createHarness(settings('google-free', false));
    discovering.session.handlePayload(catalog('title-1', 'provisional', [
      descriptor('en-main', 'en'),
    ]));
    discovering.session.handlePayload(timedText(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en',
      'Hello',
    ));
    discovering.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });
    expect(discovering.tasks.scheduled).toHaveLength(0);
    expect(discovering.status.values.at(-1)).toEqual({ mode: 'discovering' });

    const unset = createHarness(settings('unset', false));
    unset.session.handlePayload(catalog('title-2', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    unset.session.handlePayload(timedText(
      'title-2',
      'tt_fedcba9876543210',
      'en-main',
      'en',
      'Hello',
    ));
    unset.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });
    expect(unset.tasks.scheduled).toHaveLength(0);
    expect(unset.status.values.at(-1)).toEqual({ mode: 'unset' });
  });

  it('unlocks only the explicitly selected provider after native English activity is confirmed', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en',
      'Hello',
    ));
    expect(harness.tasks.scheduled).toHaveLength(0);

    harness.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(
      ({ task }) => task.provider === 'google-free' && task.cues.length === 1,
    )).toBe(true);
  });

  it('caps one native-text match to urgent work until a second distinctive cue confirms the track', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    harness.session.handlePayload(timedTextWithCues(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en',
      [
        'A distinctive opening sentence',
        'Another unmistakable English sentence',
        'The third subtitle line',
        'The fourth subtitle line',
        'The fifth subtitle line',
        'The sixth subtitle line',
      ],
    ));

    harness.ticks.emit({
      visibleText: 'A distinctive opening sentence',
      currentTimeMs: 500,
    });
    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(
      ({ task }) => task.priority === 'urgent',
    )).toBe(true);

    const beforeStrongConfirmation = harness.tasks.scheduled.length;
    harness.ticks.emit({
      visibleText: 'Another unmistakable English sentence',
      currentTimeMs: 1_500,
    });
    expect(harness.tasks.scheduled.slice(beforeStrongConfirmation).some(
      ({ task }) => task.priority === 'bulk',
    )).toBe(true);
  });

  it('selects the native-matching English variant and upgrades only that track to bulk', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('multi-en-title', 'authoritative', [
      descriptor('en-subtitle', 'en', 'subtitle'),
      descriptor('en-cc', 'en-US', 'closed-caption'),
    ]));
    harness.session.handlePayload(timedTextWithCues(
      'multi-en-title',
      'tt_1111111111111111',
      'en-subtitle',
      'en',
      [
        'Normal subtitle opening',
        'Normal subtitle second',
        'Normal subtitle third',
        'Normal subtitle fourth',
        'Normal subtitle fifth',
        'Normal subtitle sixth',
      ],
    ));
    harness.session.handlePayload(timedTextWithCues(
      'multi-en-title',
      'tt_2222222222222222',
      'en-cc',
      'en-US',
      [
        'CC subtitle opening',
        'CC subtitle second',
        'CC subtitle third',
        'CC subtitle fourth',
        'CC subtitle fifth',
        'CC subtitle sixth',
      ],
    ));
    expect(harness.tasks.scheduled).toHaveLength(0);

    harness.ticks.emit({
      visibleText: 'CC subtitle opening',
      currentTimeMs: 500,
    });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
    expect(harness.tasks.scheduled.every(({ task }) =>
      task.provider === 'google-free' &&
      task.priority === 'urgent' &&
      task.cues.every(({ text }) => text.startsWith('CC subtitle')))).toBe(true);

    const beforeStrongConfirmation = harness.tasks.scheduled.length;
    harness.ticks.emit({
      visibleText: 'CC subtitle second',
      currentTimeMs: 1_500,
    });

    const afterStrongConfirmation = harness.tasks.scheduled.slice(
      beforeStrongConfirmation,
    );
    expect(afterStrongConfirmation.some(({ task }) => task.priority === 'bulk')).toBe(true);
    expect(harness.tasks.scheduled.every(({ task }) =>
      task.cues.every(({ text }) => !text.startsWith('Normal subtitle')))).toBe(true);
  });

  it('never schedules the previously confirmed English variant after native playback switches tracks', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('switching-en-title', 'authoritative', [
      descriptor('en-subtitle', 'en', 'subtitle'),
      descriptor('en-cc', 'en-US', 'closed-caption'),
    ]));
    harness.session.handlePayload(timedTextWithCues(
      'switching-en-title',
      'tt_3333333333333333',
      'en-subtitle',
      'en',
      [
        'Normal subtitle opening',
        'Normal subtitle second',
        'Normal subtitle third',
        'Normal subtitle fourth',
        'Normal subtitle fifth',
        'Normal subtitle sixth',
      ],
    ));
    harness.session.handlePayload(timedTextWithCues(
      'switching-en-title',
      'tt_4444444444444444',
      'en-cc',
      'en-US',
      [
        'CC subtitle opening',
        'CC subtitle second',
        'CC subtitle third',
        'CC subtitle fourth',
        'CC subtitle fifth',
        'CC subtitle sixth',
      ],
    ));

    harness.ticks.emit({
      visibleText: 'Normal subtitle opening',
      currentTimeMs: 500,
    });
    harness.ticks.emit({
      visibleText: 'Normal subtitle second',
      currentTimeMs: 1_500,
    });
    expect(harness.tasks.scheduled.some(({ task }) =>
      task.priority === 'bulk' &&
      task.cues.some(({ text }) => text.startsWith('Normal subtitle')))).toBe(true);

    const beforeSwitch = harness.tasks.scheduled.length;
    harness.ticks.emit({
      visibleText: 'CC subtitle third',
      currentTimeMs: 2_500,
    });

    const afterSwitch = harness.tasks.scheduled.slice(beforeSwitch);
    expect(afterSwitch.length).toBeGreaterThan(0);
    expect(afterSwitch.every(({ task }) =>
      task.cues.every(({ text }) => text.startsWith('CC subtitle')))).toBe(true);
  });

  it('invalidates the selected provider on a settings switch and closes it after selecting Netflix native', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_0123456789abcdef',
      'en-main',
      'en',
      'Hello',
    ));
    harness.ticks.emit({ visibleText: 'Hello', currentTimeMs: 500 });
    const google = harness.tasks.scheduled[0];
    expect(google?.callbacks.isCurrent()).toBe(true);

    harness.session.updateSettings(settings('deepseek', true), {
      translationConfigurationChanged: true,
    });
    expect(google?.callbacks.isCurrent()).toBe(false);
    expect(harness.tasks.scheduled.some(
      ({ task }) => task.provider === 'deepseek',
    )).toBe(true);

    harness.session.updateSettings(settings('unset', true), {
      translationConfigurationChanged: true,
    });
    const beforeOfficial = harness.tasks.scheduled.length;
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
      descriptor('zh-main', 'zh-Hans'),
    ]));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_1111111111111111',
      'en-main',
      'en',
      'Hello',
    ));
    harness.session.handlePayload(timedText(
      'title-1',
      'tt_fedcba9876543210',
      'zh-main',
      'zh-Hans',
      '官方中文',
    ));
    expect(harness.tasks.scheduled).toHaveLength(beforeOfficial);
    expect(harness.status.values.at(-1)).toEqual({ mode: 'official' });
  });

  it('uses only a unique language alias and refuses to assign ambiguous downloaded bodies', () => {
    const unique = createHarness(settings('google-free', false));
    unique.session.handlePayload(catalog('unique-title', 'authoritative', [
      descriptor('catalog-en', 'en'),
    ]));
    unique.session.handlePayload(timedText(
      'unique-title',
      'tt_0123456789abcdef',
      'network-resource-id',
      'en-US',
      'Unique',
    ));
    unique.ticks.emit({ visibleText: 'Unique', currentTimeMs: 500 });
    expect(unique.tasks.scheduled.length).toBeGreaterThan(0);

    const ambiguous = createHarness(settings('google-free', false));
    ambiguous.session.handlePayload(catalog('ambiguous-title', 'authoritative', [
      descriptor('en-subtitle', 'en', 'subtitle'),
      descriptor('en-cc', 'en-US', 'closed-caption'),
    ]));
    ambiguous.session.handlePayload(timedText(
      'ambiguous-title',
      'tt_fedcba9876543210',
      'network-resource-id',
      'en',
      'Ambiguous downloaded body',
    ));
    ambiguous.ticks.emit({ visibleText: 'Ambiguous visible line', currentTimeMs: 500 });

    expect(ambiguous.diagnostics).not.toContainEqual({
      code: 'timed_text_accepted',
      detail: 'partial',
    });
    expect(ambiguous.tasks.scheduled.some(({ task }) =>
      task.cues.some(({ text }) => text === 'Ambiguous visible line'))).toBe(true);
    expect(ambiguous.tasks.scheduled.every(({ task }) =>
      task.cues.every(({ text }) => text !== 'Ambiguous downloaded body'))).toBe(true);
  });

  it('ignores a foreign provisional catalog while an authoritative title is active', () => {
    const harness = createHarness(settings('unset', false));
    harness.session.handlePayload(catalog('current-title', 'authoritative', [
      descriptor('current-en', 'en'),
    ]));
    const statesBeforePreview = harness.states.length;

    harness.session.handlePayload(catalog('preview-title', 'provisional', [
      descriptor('preview-en', 'en'),
    ]));

    expect(harness.restarts).toEqual([]);
    expect(harness.states).toHaveLength(statesBeforePreview);

    harness.session.handlePayload(catalog('next-title', 'authoritative', [
      descriptor('next-en', 'en'),
    ]));
    expect(harness.restarts).toEqual([]);
  });

  it('rejects timed text whose title does not match the active catalog', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    const resourceId = 'tt_0123456789abcdef';
    harness.session.handlePayload(timedText(
      'preview-title',
      resourceId,
      'en-main',
      'en',
      'Wrong episode subtitle',
    ));

    expect(harness.diagnostics.map(({ code }) => code))
      .not.toContain('timed_text_accepted');

    harness.session.handlePayload(timedText(
      'title-1',
      resourceId,
      'en-main',
      'en',
      'Current episode subtitle',
    ));
    harness.ticks.emit({
      visibleText: 'Current episode subtitle',
      currentTimeMs: 500,
    });
    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
  });

  it('accepts a complete retry after an incomplete timed-text body fails to parse', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    const resourceId = 'tt_0123456789abcdef';
    harness.session.handlePayload({
      ...timedText('title-1', resourceId, 'en-main', 'en', 'ignored'),
      body: 'incomplete timed text',
    });
    harness.session.handlePayload(timedText(
      'title-1',
      resourceId,
      'en-main',
      'en',
      'Recovered subtitle',
    ));

    harness.ticks.emit({
      visibleText: 'Recovered subtitle',
      currentTimeMs: 500,
    });

    expect(harness.tasks.scheduled.length).toBeGreaterThan(0);
  });

  it('replaces a valid partial resource body with a more complete body', () => {
    const harness = createHarness(settings('google-free', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    const resourceId = 'tt_0123456789abcdef';
    harness.session.handlePayload(timedTextWithCues(
      'title-1',
      resourceId,
      'en-main',
      'en',
      ['First partial cue'],
    ));
    harness.ticks.emit({ visibleText: 'First partial cue', currentTimeMs: 500 });

    harness.session.handlePayload(timedTextWithCues(
      'title-1',
      resourceId,
      'en-main',
      'en',
      ['First partial cue', 'Second recovered cue'],
    ));
    harness.ticks.emit({ visibleText: 'Second recovered cue', currentTimeMs: 1_500 });

    expect(harness.tasks.scheduled.some(({ task }) =>
      task.cues.some(({ text }) => text === 'Second recovered cue'))).toBe(true);
  });

  it('keeps parsed tracks and the page bridge alive when Netflix replaces the video node', () => {
    const harness = createHarness(settings('unset', false));
    harness.session.handlePayload(catalog('remount-title', 'authoritative', [
      descriptor('en-main', 'en'),
      descriptor('zh-main', 'zh-Hans'),
    ]));
    harness.session.handlePayload(timedText(
      'remount-title',
      'tt_1111111111111111',
      'en-main',
      'en',
      'English survives remount',
    ));
    harness.session.handlePayload(timedText(
      'remount-title',
      'tt_2222222222222222',
      'zh-main',
      'zh-Hans',
      '重挂后保留中文',
    ));
    harness.ticks.emit({
      visibleText: 'English survives remount',
      currentTimeMs: 500,
    });
    expect(harness.overlay.last()).toMatchObject({
      english: 'English survives remount',
      chinese: '重挂后保留中文',
    });
    const clearsBeforeRemount = harness.overlay.clearCount;
    const cancellationsBeforeRemount = harness.tasks.cancelled.length;
    const statesBeforeRemount = harness.states.length;

    harness.session.playerRemounted('remount-title');
    harness.ticks.emit({
      visibleText: 'English survives remount',
      currentTimeMs: 500,
    });

    expect(harness.restarts).toEqual([]);
    expect(harness.overlay.clearCount).toBe(clearsBeforeRemount);
    expect(harness.tasks.cancelled).toHaveLength(cancellationsBeforeRemount);
    expect(harness.states).toHaveLength(statesBeforeRemount);
    expect(harness.overlay.last()).toMatchObject({
      english: 'English survives remount',
      chinese: '重挂后保留中文',
    });
  });

  it('clears old cues on a different-title remount and recovers from the new catalog', () => {
    const harness = createHarness(settings('unset', false));
    harness.session.handlePayload(catalog('episode-one', 'authoritative', [
      descriptor('en-one', 'en'),
      descriptor('zh-one', 'zh-Hans'),
    ]));
    harness.session.handlePayload(timedTextWithCues(
      'episode-one',
      'tt_1111111111111111',
      'en-one',
      'en',
      ['Old English one', 'Old English two'],
    ));
    harness.session.handlePayload(timedTextWithCues(
      'episode-one',
      'tt_2222222222222222',
      'zh-one',
      'zh-Hans',
      ['旧中文一', '旧中文二'],
    ));
    harness.ticks.emit({ visibleText: 'Old English one', currentTimeMs: 500 });
    const clearsBeforeRemount = harness.overlay.clearCount;
    const rendersBeforeRemount = harness.overlay.states.length;

    harness.session.playerRemounted('episode-two');

    expect(harness.restarts).toEqual([]);
    expect(harness.overlay.clearCount).toBeGreaterThan(clearsBeforeRemount);
    expect(harness.states.at(-1)).toMatchObject({
      generation: 2,
      state: 'active',
    });
    harness.session.handlePayload(catalog('episode-one', 'authoritative', [
      descriptor('en-one', 'en'),
      descriptor('zh-one', 'zh-Hans'),
    ]));
    harness.session.handlePayload(timedText(
      'episode-one',
      'tt_5555555555555555',
      'en-one',
      'en',
      'Late old English',
    ));
    harness.ticks.emit({ currentTimeMs: 1_500 });
    expect(harness.overlay.states).toHaveLength(rendersBeforeRemount);

    harness.session.handlePayload(catalog('episode-two', 'authoritative', [
      descriptor('en-two', 'en'),
      descriptor('zh-two', 'zh-Hans'),
    ]));
    harness.session.handlePayload(timedText(
      'episode-two',
      'tt_3333333333333333',
      'en-two',
      'en',
      'New English',
    ));
    harness.session.handlePayload(timedText(
      'episode-two',
      'tt_4444444444444444',
      'zh-two',
      'zh-Hans',
      '新中文',
    ));
    harness.ticks.emit({ visibleText: 'New English', currentTimeMs: 500 });

    expect(harness.overlay.last()).toEqual({
      english: 'New English',
      chinese: '新中文',
    });
    expect(harness.states.at(-1)?.generation).toBe(2);
  });

  it('keeps the page bridge alive while an authoritative catalog changes episodes', () => {
    const harness = createHarness(settings('unset', false));
    harness.session.handlePayload(catalog('episode-one', 'authoritative', [
      descriptor('en-one', 'en'),
    ]));
    harness.session.handlePayload(catalog('episode-two', 'authoritative', [
      descriptor('en-two', 'en'),
    ]));

    expect(harness.restarts).toEqual([]);
    expect(harness.states.at(-1)).toMatchObject({
      generation: 2,
      state: 'active',
    });
  });

  it('reports episode lifecycle once and ignores DOM remounts and work after disposal', () => {
    const harness = createHarness(settings('unset', false));
    harness.session.handlePayload(catalog('title-1', 'authoritative', [
      descriptor('en-main', 'en'),
    ]));
    harness.session.handlePayload(catalog('title-2', 'authoritative', [
      descriptor('en-next', 'en'),
    ]));
    harness.session.playerRemounted('title-2');
    harness.session.dispose();
    harness.session.dispose();
    const reportsBeforeLatePayload = harness.states.length;
    harness.session.handlePayload(catalog('title-3', 'authoritative', []));

    expect(harness.restarts).toEqual([]);
    expect(harness.states.map(({ state }) => state)).toEqual([
      'active',
      'disposed',
      'active',
      'disposed',
    ]);
    expect(harness.states.map(({ generation }) => generation)).toEqual([
      1,
      1,
      2,
      2,
    ]);
    expect(harness.states).toHaveLength(reportsBeforeLatePayload);
    expect(harness.overlay.clearCount).toBeGreaterThan(0);
  });

  it('keeps task generations aligned after episode changes without advancing on DOM remounts', () => {
    const harness = createHarness(settings('google-free', false));
    const loadTrack = (
      titleId: string,
      resourceId: string,
      trackId: string,
      text: string,
    ): void => {
      harness.session.handlePayload(catalog(titleId, 'authoritative', [
        descriptor(trackId, 'en'),
      ]));
      harness.session.handlePayload(timedText(
        titleId,
        resourceId,
        trackId,
        'en',
        text,
      ));
      harness.ticks.emit({ visibleText: text, currentTimeMs: 500 });
    };

    loadTrack('generation-title-1', 'tt_1111111111111111', 'en-one', 'First episode');
    expect(harness.tasks.scheduled.at(-1)?.task.episodeGeneration).toBe(1);

    const beforeEpisodeChange = harness.tasks.scheduled.length;
    loadTrack('generation-title-2', 'tt_2222222222222222', 'en-two', 'Second episode');
    const secondState = harness.states.at(-1);
    const secondTasks = harness.tasks.scheduled.slice(beforeEpisodeChange);
    expect(secondState?.generation).toBe(2);
    expect(secondTasks.length).toBeGreaterThan(0);
    expect(secondTasks.every(({ task }) =>
      task.episodeGeneration === secondState?.generation &&
      task.sessionId === secondState?.sessionId)).toBe(true);

    harness.session.playerRemounted('generation-title-2');
    const beforeRemount = harness.tasks.scheduled.length;
    loadTrack('generation-title-2', 'tt_3333333333333333', 'en-two', 'Remounted player');
    const remountedState = harness.states.at(-1);
    const remountedTasks = harness.tasks.scheduled.slice(beforeRemount);
    expect(remountedState?.generation).toBe(2);
    expect(remountedTasks.length).toBeGreaterThan(0);
    expect(remountedTasks.every(({ task }) =>
      task.episodeGeneration === remountedState?.generation &&
      task.sessionId === remountedState?.sessionId)).toBe(true);
  });
});

function createHarness(runtimeSettings: RuntimeSettingsState) {
  const ticks = new RecordingTicks(500);
  const tasks = new RecordingTasks();
  const overlay = new RecordingOverlay();
  const status = new RecordingStatus();
  const states: NetflixContentSessionState[] = [];
  const restarts: NetflixContentRestartReason[] = [];
  const diagnostics: Array<{ readonly code: string; readonly detail?: string }> = [];
  const session = createNetflixContentSession({
    settings: runtimeSettings,
    tickSource: ticks,
    taskClient: tasks,
    overlay,
    status,
    nonceFactory: () => '0123456789abcdef0123456789abcdef',
    onSessionState: (state) => states.push(state),
    onBridgeRestart: (reason) => restarts.push(reason),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { session, ticks, tasks, overlay, status, states, restarts, diagnostics };
}

class RecordingTicks implements SubtitleSessionTickSource {
  private readonly listeners = new Set<(tick: SubtitleSessionTick) => void>();

  constructor(private readonly timeMs: number | undefined) {}

  currentTimeMs(): number | undefined {
    return this.timeMs;
  }

  subscribe(listener: (tick: SubtitleSessionTick) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(tick: SubtitleSessionTick): void {
    for (const listener of [...this.listeners]) listener(tick);
  }
}

class RecordingTasks implements ProviderNeutralTaskClient {
  readonly scheduled: Array<{
    readonly task: ScheduledTranslationTask;
    readonly callbacks: TranslationTaskCallbacks;
  }> = [];
  readonly cancelled: Array<{
    readonly generation: SchedulerGeneration;
    readonly reason: SessionCancellationReason;
  }> = [];

  enqueue(task: ScheduledTranslationTask, callbacks: TranslationTaskCallbacks): void {
    this.scheduled.push({ task, callbacks });
  }

  cancel(generation: SchedulerGeneration, reason: SessionCancellationReason): void {
    this.cancelled.push({ generation, reason });
  }
}

class RecordingOverlay implements SessionOverlaySink {
  readonly states: NormalizedActiveCueState[] = [];
  clearCount = 0;

  render(state: NormalizedActiveCueState): boolean {
    this.states.push(state);
    return true;
  }

  clear(): void {
    this.clearCount += 1;
  }

  last(): NormalizedActiveCueState | undefined {
    return this.states.at(-1);
  }
}

class RecordingStatus implements SessionStatusSink {
  readonly values: Parameters<SessionStatusSink['publish']>[0][] = [];

  publish(status: Parameters<SessionStatusSink['publish']>[0]): void {
    this.values.push(status);
  }
}

function settings(
  provider: RuntimeSettingsState['provider'],
  deepseekKeyReady: boolean,
): RuntimeSettingsState {
  return {
    enabled: true,
    provider,
    deepseekKeyReady,
    appearance: DEFAULT_SETTINGS.appearance,
  };
}

function catalog(
  titleId: string,
  authority: 'authoritative' | 'provisional',
  tracks: ReturnType<typeof descriptor>[],
): Extract<NetflixBridgePayload, { type: 'catalog' }> {
  return { type: 'catalog', titleId, authority, tracks };
}

function descriptor(
  id: string,
  language: string,
  kind: 'subtitle' | 'closed-caption' = 'subtitle',
) {
  return { id, language, kind } as const;
}

function timedText(
  titleId: string,
  resourceId: string,
  trackId: string,
  language: string,
  text: string,
): Extract<NetflixBridgePayload, { type: 'timed-text' }> {
  return {
    type: 'timed-text',
    titleId,
    resourceId,
    trackId,
    language,
    format: 'webvtt',
    body: `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${text}\n`,
  };
}

function timedTextWithCues(
  titleId: string,
  resourceId: string,
  trackId: string,
  language: string,
  texts: readonly string[],
): Extract<NetflixBridgePayload, { type: 'timed-text' }> {
  const body = texts.map((text, index) => {
    const start = String(index).padStart(2, '0');
    const end = String(index + 1).padStart(2, '0');
    return `00:00:${start}.000 --> 00:00:${end}.000\n${text}`;
  }).join('\n\n');
  return {
    type: 'timed-text',
    titleId,
    resourceId,
    trackId,
    language,
    format: 'webvtt',
    body: `WEBVTT\n\n${body}\n`,
  };
}
