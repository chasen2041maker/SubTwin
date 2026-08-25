import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  SubtitleOverlay,
  mountSubtitleOverlay,
  verticalOffsetFromDrag,
  type NormalizedActiveCueState,
  type SubtitleOverlayAppearance,
  type SubtitleOverlayDocument,
  type SubtitleOverlayHostObserver,
  type SubtitleOverlayNode,
  type SubtitleOverlayRenderLifecycle,
  type SubtitleOverlayRenderRoot,
} from '../../src/renderer/SubtitleOverlay';

const overlayCss = readFileSync(
  new URL('../../src/renderer/subtitle-overlay.css', import.meta.url),
  'utf8',
);

const appearance: SubtitleOverlayAppearance = {
  english: {
    visible: true,
    color: '#F7F4EC',
    fontFamily: 'sans',
    fontSizePx: 28,
    fontWeight: 600,
  },
  chinese: {
    visible: true,
    color: '#FFFFFF',
    fontFamily: 'rounded',
    fontSizePx: 32,
    fontWeight: 600,
  },
  order: 'english-first',
  lineSpacingPx: 8,
  maxLineWidthPercent: 96,
  verticalOffsetPercent: 8,
  backgroundOpacity: 0.55,
  shadow: 'soft',
};

const activeState: NormalizedActiveCueState = {
  english: 'We are what we choose to be.',
  chinese: '我们由自己的选择塑造。',
};

describe('SubtitleOverlay', () => {
  it('renders normalized cue state deterministically with appearance variables', () => {
    const first = renderToStaticMarkup(
      <SubtitleOverlay state={activeState} appearance={appearance} />,
    );
    const second = renderToStaticMarkup(
      <SubtitleOverlay state={activeState} appearance={appearance} />,
    );

    expect(first).toBe(second);
    expect(first).toContain('data-order="english-first"');
    expect(first).toContain('data-language="english"');
    expect(first).toContain('data-language="chinese"');
    expect(first.indexOf('data-language="english"')).toBeLessThan(
      first.indexOf('data-language="chinese"'),
    );
    expect(first).toContain('--subtwin-en-color:#F7F4EC');
    expect(first).toContain('--subtwin-en-size:28px');
    expect(first).toContain('--subtwin-zh-size:32px');
    expect(first).toContain('--subtwin-line-spacing:8px');
    expect(first).toContain('--subtwin-max-line-width:96vw');
    expect(first).toContain('--subtwin-vertical-offset:8');
    expect(first).toContain('--subtwin-background-opacity:0.55');
    expect(first).toContain('--subtwin-text-shadow:0 1px 2px rgb(0 0 0 / 0.9)');
  });

  it('supports independent language visibility and translation-first ordering', () => {
    const chineseOnly = renderToStaticMarkup(
      <SubtitleOverlay
        state={activeState}
        appearance={{
          ...appearance,
          english: { ...appearance.english, visible: false },
          order: 'chinese-first',
        }}
      />,
    );
    expect(chineseOnly).not.toContain('data-language="english"');
    expect(chineseOnly).toContain('data-language="chinese"');

    const reversed = renderToStaticMarkup(
      <SubtitleOverlay
        state={activeState}
        appearance={{ ...appearance, order: 'chinese-first' }}
      />,
    );
    expect(reversed.indexOf('data-language="chinese"')).toBeLessThan(
      reversed.indexOf('data-language="english"'),
    );
  });

  it('renders nothing when every visible line is empty', () => {
    expect(
      renderToStaticMarkup(
        <SubtitleOverlay
          state={{ english: '  ', chinese: null }}
          appearance={appearance}
        />,
      ),
    ).toBe('');
  });

  it('lets the line-width setting control source captions with embedded line breaks', () => {
    const markup = renderToStaticMarkup(
      <SubtitleOverlay
        state={{
          english: 'You saw the guys\nthat shot at us, right?',
          chinese: '你们看到了\n朝我们开枪的人 对吗？',
        }}
        appearance={{ ...appearance, maxLineWidthPercent: 100 }}
      />,
    );

    expect(markup).toContain('You saw the guys that shot at us, right?');
    expect(markup).toContain('你们看到了 朝我们开枪的人 对吗？');
    expect(markup).not.toContain('guys\nthat');
    expect(markup).not.toContain('看到了\n朝');
  });

  it('keeps the full-screen layer pointer-transparent and safe-area aware', () => {
    expect(overlayCss).toContain('pointer-events: none');
    expect(overlayCss).toContain('env(safe-area-inset-bottom');
    expect(overlayCss).toContain('position: fixed');
    expect(overlayCss).toContain('z-index: 2147483000');
    expect(overlayCss).not.toMatch(/gradient|animation|glow/iu);
  });

  it('uses a compact Lingosive-like subtitle surface instead of poster styling', () => {
    expect(overlayCss).toContain('max-width: min(var(--subtwin-max-line-width), calc(100vw - 32px))');
    expect(overlayCss).toContain('width: max-content');
    expect(overlayCss).toContain('border-radius: 0.38em');
    expect(overlayCss).toContain('line-height: 1.2');
    expect(overlayCss).toContain('"Noto Sans SC"');
  });

  it('previews direct subtitle dragging only while edit mode is enabled', () => {
    const markup = renderToStaticMarkup(
      <SubtitleOverlay
        appearance={appearance}
        dragEnabled
        onVerticalOffsetChange={() => undefined}
        state={activeState}
      />,
    );

    expect(markup).toContain('data-drag-enabled="true"');
    expect(overlayCss).toContain('content: "拖动字幕"');
    expect(overlayCss).toMatch(/data-drag-enabled="true"[\s\S]*pointer-events:\s*auto/iu);
  });

  it('maps direct vertical dragging to a live 0–80 percent offset', () => {
    expect(verticalOffsetFromDrag(20, 500, 400, 1_000)).toBe(30);
    expect(verticalOffsetFromDrag(20, 500, 900, 1_000)).toBe(0);
    expect(verticalOffsetFromDrag(70, 500, -500, 1_000)).toBe(80);
    expect(verticalOffsetFromDrag(20, 500, 400, 0)).toBe(20);
  });
});

describe('subtitle overlay mount lifecycle', () => {
  it('fails mounting and preserves native subtitles when the first host append throws', () => {
    const document = new FakeDocument();
    document.documentElement.throwOnAppend = true;
    const root = new FakeRenderRoot();
    const visibility: string[] = [];

    expect(() => mountSubtitleOverlay({
      document,
      createRenderRoot: () => root,
      nativeVisibility: {
        hide: () => visibility.push('hide'),
        restore: () => visibility.push('restore'),
      },
    })).toThrow('subtitle overlay host');

    expect(visibility).toEqual(['restore']);
    expect(root.unmountCount).toBe(1);
    expect(document.listenerCount).toBe(0);
    expect(document.documentElement.children).toHaveLength(0);
  });

  it('hides native subtitles only after a committed bilingual cue', () => {
    const document = new FakeDocument();
    const root = new FakeRenderRoot();
    const visibility: string[] = [];
    const mount = mountSubtitleOverlay({
      document,
      createRenderRoot: () => root,
      nativeVisibility: {
        hide: () => visibility.push('hide'),
        restore: () => visibility.push('restore'),
      },
    });

    expect(mount.render(activeState, appearance)).toBe(true);
    expect(visibility).toEqual([]);
    root.commit();
    expect(visibility).toEqual(['hide']);

    mount.render({ english: 'English only', chinese: null }, appearance);
    root.commit();
    expect(visibility).toEqual(['hide', 'restore']);

    mount.render({ english: null, chinese: '   ' }, appearance);
    expect(visibility).toEqual(['hide', 'restore']);
    root.commitStale();
    expect(visibility).toEqual(['hide', 'restore']);
  });

  it('suppresses native subtitles immediately while SubTwin is enabled', () => {
    const document = new FakeDocument();
    const root = new FakeRenderRoot();
    const visibility: string[] = [];
    const mount = mountSubtitleOverlay({
      document,
      createRenderRoot: () => root,
      nativeVisibility: {
        hide: () => visibility.push('hide'),
        restore: () => visibility.push('restore'),
      },
    });

    mount.setNativeSubtitlesHidden(true);
    expect(visibility).toEqual(['hide']);

    mount.clear();
    expect(visibility).toEqual(['hide']);

    mount.setNativeSubtitlesHidden(false);
    expect(visibility).toEqual(['hide', 'restore']);
  });

  it('restores native subtitles on render failure and disposal', () => {
    const document = new FakeDocument();
    const root = new FakeRenderRoot();
    const visibility: string[] = [];
    const mount = mountSubtitleOverlay({
      document,
      createRenderRoot: () => root,
      nativeVisibility: {
        hide: () => visibility.push('hide'),
        restore: () => visibility.push('restore'),
      },
    });

    mount.render(activeState, appearance);
    root.commit();
    root.fail();
    expect(visibility).toEqual(['hide', 'restore']);

    mount.render(activeState, appearance);
    root.commit();
    mount.dispose();
    mount.dispose();
    expect(visibility).toEqual(['hide', 'restore', 'hide', 'restore']);
    expect(root.unmountCount).toBe(1);
    expect(document.listenerCount).toBe(0);
    expect(document.documentElement.children).toHaveLength(0);
  });

  it('reuses one host and one fullscreen listener until disposal', () => {
    const document = new FakeDocument();
    const root = new FakeRenderRoot();
    const nativeVisibility = { hide: () => undefined, restore: () => undefined };
    const first = mountSubtitleOverlay({
      document,
      createRenderRoot: () => root,
      nativeVisibility,
    });
    const second = mountSubtitleOverlay({
      document,
      createRenderRoot: () => {
        throw new Error('must not create a second root');
      },
      nativeVisibility,
    });

    expect(second).toBe(first);
    expect(document.documentElement.children).toHaveLength(1);
    expect(document.listenerCount).toBe(1);

    document.fullscreenElement = new FakeNode();
    document.emitFullscreenChange();
    expect(document.fullscreenElement.children).toHaveLength(1);
    expect(document.documentElement.children).toHaveLength(0);

    first.dispose();
  });

  it('does not hide native subtitles when the host is removed before commit', () => {
    const document = new FakeDocument();
    const root = new FakeRenderRoot();
    const visibility: string[] = [];
    const mount = mountSubtitleOverlay({
      document,
      createRenderRoot: () => root,
      nativeVisibility: {
        hide: () => visibility.push('hide'),
        restore: () => visibility.push('restore'),
      },
    });

    expect(mount.render(activeState, appearance)).toBe(true);
    const host = document.documentElement.children[0];
    expect(host).toBeDefined();
    host?.remove();
    root.commit();

    expect(visibility).toEqual([]);
    expect(document.documentElement.children).toHaveLength(0);
    mount.dispose();
  });

  it('restores native subtitles and reliably reattaches a host removed between cues', () => {
    const document = new FakeDocument();
    const root = new FakeRenderRoot();
    const visibility: string[] = [];
    const mount = mountSubtitleOverlay({
      document,
      createRenderRoot: () => root,
      nativeVisibility: {
        hide: () => visibility.push('hide'),
        restore: () => visibility.push('restore'),
      },
    });

    mount.render(activeState, appearance);
    root.commit();
    const host = document.documentElement.children[0];
    host?.remove();

    expect(mount.render(activeState, appearance)).toBe(true);
    expect(visibility).toEqual(['hide', 'restore']);
    expect(document.documentElement.children).toEqual([host]);
    root.commit();
    expect(visibility).toEqual(['hide', 'restore', 'hide']);

    mount.dispose();
  });

  it('restores native subtitles immediately when a committed host is removed', () => {
    const document = new FakeDocument();
    const root = new FakeRenderRoot();
    const hostObserver = new FakeHostObserver();
    const visibility: string[] = [];
    const mount = mountSubtitleOverlay({
      document,
      createHostObserver: (callback) => hostObserver.bind(callback),
      createRenderRoot: () => root,
      nativeVisibility: {
        hide: () => visibility.push('hide'),
        restore: () => visibility.push('restore'),
      },
    });

    mount.render(activeState, appearance);
    root.commit();
    const host = document.documentElement.children[0];
    expect(host).toBeDefined();
    host?.remove();
    hostObserver.notify();

    expect(visibility).toEqual(['hide', 'restore']);
    expect(document.documentElement.children).toEqual([host]);
    expect(root.rendered.at(-1)).toBeNull();

    mount.render(activeState, appearance);
    root.commit();
    expect(visibility).toEqual(['hide', 'restore', 'hide']);

    mount.dispose();
    expect(hostObserver.disconnectCount).toBe(1);
    hostObserver.notify();
    expect(visibility).toEqual(['hide', 'restore', 'hide', 'restore']);
  });
});

class FakeRenderRoot implements SubtitleOverlayRenderRoot {
  readonly rendered: ReactNode[] = [];
  unmountCount = 0;
  private currentLifecycle: SubtitleOverlayRenderLifecycle | undefined;
  private staleLifecycle: SubtitleOverlayRenderLifecycle | undefined;

  render(node: ReactNode, lifecycle: SubtitleOverlayRenderLifecycle): void {
    this.rendered.push(node);
    this.staleLifecycle = this.currentLifecycle;
    this.currentLifecycle = lifecycle;
  }

  clear(): void {
    this.rendered.push(null);
    this.staleLifecycle = this.currentLifecycle;
    this.currentLifecycle = undefined;
  }

  unmount(): void {
    this.unmountCount += 1;
  }

  commit(): void {
    this.currentLifecycle?.onCommit();
  }

  commitStale(): void {
    this.staleLifecycle?.onCommit();
  }

  fail(): void {
    this.currentLifecycle?.onError();
  }
}

class FakeHostObserver implements SubtitleOverlayHostObserver {
  disconnectCount = 0;
  private callback: (() => void) | undefined;

  bind(callback: () => void): FakeHostObserver {
    this.callback = callback;
    return this;
  }

  observe(): void {}

  disconnect(): void {
    this.disconnectCount += 1;
    this.callback = undefined;
  }

  notify(): void {
    this.callback?.();
  }
}

class FakeNode implements SubtitleOverlayNode {
  id = '';
  className = '';
  textContent: string | null = null;
  isConnected = false;
  readonly children: FakeNode[] = [];
  throwOnAppend = false;
  private parent: FakeNode | undefined;

  append(...nodes: readonly SubtitleOverlayNode[]): void {
    if (this.throwOnAppend) throw new Error('append failed');
    for (const candidate of nodes) {
      const node = candidate as FakeNode;
      node.remove();
      node.parent = this;
      node.isConnected = true;
      this.children.push(node);
    }
  }

  attachShadow(): SubtitleOverlayNode {
    const shadow = new FakeNode();
    shadow.isConnected = true;
    this.children.push(shadow);
    return shadow;
  }

  remove(): void {
    if (this.parent !== undefined) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = undefined;
    }
    this.isConnected = false;
  }
}

class FakeDocument implements SubtitleOverlayDocument {
  readonly documentElement = new FakeNode();
  fullscreenElement: FakeNode | null = null;
  private readonly nodes: FakeNode[] = [];
  private readonly listeners = new Set<() => void>();

  createElement(): FakeNode {
    const node = new FakeNode();
    this.nodes.push(node);
    return node;
  }

  getElementById(id: string): FakeNode | null {
    return this.nodes.find((node) => node.id === id && node.isConnected) ?? null;
  }

  addEventListener(_type: 'fullscreenchange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'fullscreenchange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  emitFullscreenChange(): void {
    this.listeners.forEach((listener) => listener());
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
