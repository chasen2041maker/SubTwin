import { describe, expect, it } from 'vitest';

import { createNetflixContentSession } from '../../src/app/netflix-content-session';
import type {
  ProviderNeutralTaskClient,
  SessionOverlaySink,
  SessionStatusSink,
  SubtitleSessionTick,
  SubtitleSessionTickSource,
  TranslationTaskCallbacks,
} from '../../src/app/session-controller';
import type { NetflixBridgePayload } from '../../src/netflix/bridge';
import { DEFAULT_SETTINGS } from '../../src/storage/schema';
import type { ScheduledTranslationTask, SchedulerGeneration } from '../../src/translation/scheduler';

class Ticks implements SubtitleSessionTickSource {
  readonly listeners = new Set<(tick: SubtitleSessionTick) => void>();
  currentTimeMs(): number { return 500; }
  subscribe(listener: (tick: SubtitleSessionTick) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(tick: SubtitleSessionTick): void {
    for (const listener of [...this.listeners]) listener(tick);
  }
}

class Tasks implements ProviderNeutralTaskClient {
  readonly values: Array<{ task: ScheduledTranslationTask; callbacks: TranslationTaskCallbacks }> = [];
  enqueue(task: ScheduledTranslationTask, callbacks: TranslationTaskCallbacks): void {
    this.values.push({ task, callbacks });
  }
  cancel(_generation: SchedulerGeneration): void {}
  current(): Array<{ task: ScheduledTranslationTask; callbacks: TranslationTaskCallbacks }> {
    return this.values.filter(({ callbacks }) => callbacks.isCurrent());
  }
}

const overlay: SessionOverlaySink = {
  render: () => true,
  clear: () => undefined,
};
const status: SessionStatusSink = { publish: () => undefined };

function catalog(): Extract<NetflixBridgePayload, { type: 'catalog' }> {
  return {
    type: 'catalog',
    titleId: 'multi-track-title',
    authority: 'authoritative',
    tracks: [
      { id: 'a-subtitle', language: 'en', kind: 'subtitle' },
      { id: 'z-cc', language: 'en-US', kind: 'closed-caption' },
    ],
  };
}

function timedText(
  resourceId: string,
  trackId: string,
  language: string,
  lines: readonly string[],
): Extract<NetflixBridgePayload, { type: 'timed-text' }> {
  const cues = lines.map((text, index) => {
    const start = String(index).padStart(2, '0');
    const end = String(index + 1).padStart(2, '0');
    return `00:00:${start}.000 --> 00:00:${end}.000\n${text}`;
  }).join('\n\n');
  return {
    type: 'timed-text',
    titleId: 'multi-track-title',
    resourceId,
    trackId,
    language,
    format: 'webvtt',
    body: `WEBVTT\n\n${cues}\n`,
  };
}

describe('Netflix multi-English track selection', () => {
  it('translates English CC when native Netflix text proves CC is selected', () => {
    const ticks = new Ticks();
    const tasks = new Tasks();
    const session = createNetflixContentSession({
      settings: {
        enabled: true,
        provider: 'google-free',
        deepseekKeyReady: false,
        appearance: DEFAULT_SETTINGS.appearance,
      },
      tickSource: ticks,
      taskClient: tasks,
      overlay,
      status,
      nonceFactory: () => '0123456789abcdef0123456789abcdef',
    });

    session.handlePayload(catalog());
    session.handlePayload(timedText(
      'tt_1111111111111111',
      'a-subtitle',
      'en',
      ['Normal subtitle line', 'Another normal subtitle line'],
    ));
    session.handlePayload(timedText(
      'tt_2222222222222222',
      'z-cc',
      'en-US',
      ['CC subtitle line', 'Another CC subtitle line'],
    ));

    expect(tasks.values).toHaveLength(0);
    ticks.emit({ visibleText: 'CC subtitle line', currentTimeMs: 500 });

    const currentTasks = tasks.current();
    expect(currentTasks.length).toBeGreaterThan(0);
    const translatedTexts = currentTasks.flatMap(({ task }) =>
      task.cues.map(({ text }) => text));
    expect(translatedTexts).toContain('CC subtitle line');
    expect(translatedTexts).not.toContain('Normal subtitle line');
    expect(currentTasks.every(({ task }) => task.provider === 'google-free')).toBe(true);
  });

  it('does not guess when the same native line matches both English tracks', () => {
    const ticks = new Ticks();
    const tasks = new Tasks();
    const session = createNetflixContentSession({
      settings: {
        enabled: true,
        provider: 'google-free',
        deepseekKeyReady: false,
        appearance: DEFAULT_SETTINGS.appearance,
      },
      tickSource: ticks,
      taskClient: tasks,
      overlay,
      status,
      nonceFactory: () => 'fedcba9876543210fedcba9876543210',
    });

    session.handlePayload(catalog());
    session.handlePayload(timedText(
      'tt_3333333333333333',
      'a-subtitle',
      'en',
      ['Same line'],
    ));
    session.handlePayload(timedText(
      'tt_4444444444444444',
      'z-cc',
      'en-US',
      ['Same line'],
    ));
    ticks.emit({ visibleText: 'Same line', currentTimeMs: 500 });

    expect(tasks.values).toHaveLength(0);
  });
});
