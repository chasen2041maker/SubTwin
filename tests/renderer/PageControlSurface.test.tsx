import { readFileSync } from 'node:fs';
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  PageControlSurface,
  clampFloatingPosition,
  mountPageControlSurface,
  type PageControlDocument,
  type PageControlNode,
  type PageControlRenderRoot,
  type PageControlSurfaceModel,
} from '../../src/renderer/PageControlSurface';
import { DEFAULT_SETTINGS } from '../../src/storage/schema';

vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return {
    ...react,
    useRef: <Value,>(initialValue: Value) => ({ current: initialValue }),
  };
});

const controlCss = readFileSync(
  new URL('../../src/renderer/page-control-surface.css', import.meta.url),
  'utf8',
);

const model: PageControlSurfaceModel = {
  settings: {
    enabled: true,
    provider: 'google-free',
    deepseekKeyReady: false,
    appearance: DEFAULT_SETTINGS.appearance,
  },
  paused: false,
  saveState: 'saved',
  pipeline: '字幕已解析，可显示双语',
  status: { mode: 'official' },
  metadata: {
    title: '纸牌屋',
    playback: 'playing',
    audioTrack: '英语 [原始]',
    subtitleTrack: '英语 (CC)',
  },
  catalog: {
    authority: 'authoritative',
    englishTrack: 'en-US · closed-caption',
    chineseTrack: 'zh-Hans · subtitle',
    officialChinese: true,
  },
};

describe('PageControlSurface', () => {
  it('keeps the page quiet until the floating button is opened', () => {
    const markup = renderToStaticMarkup(
      <PageControlSurface
        expanded={false}
        model={model}
        position={{ x: 1200, y: 600 }}
        onAppearanceChange={vi.fn()}
        onEnabledChange={vi.fn()}
        onExpandedChange={vi.fn()}
        onPausedChange={vi.fn()}
        onPositionChange={vi.fn()}
        onProviderChange={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="打开 SubTwin 控制台"');
    expect(markup).toContain('data-subtwin-control="launcher"');
    expect(markup).not.toContain('data-subtwin-control="panel"');
  });

  it('renders status, Netflix metadata and every required live subtitle control', () => {
    const markup = renderToStaticMarkup(
      <PageControlSurface
        expanded
        model={model}
        position={{ x: 1200, y: 600 }}
        onAppearanceChange={vi.fn()}
        onEnabledChange={vi.fn()}
        onExpandedChange={vi.fn()}
        onPausedChange={vi.fn()}
        onPositionChange={vi.fn()}
        onProviderChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-subtwin-control="panel"');
    expect(markup).toContain('纸牌屋');
    expect(markup).toContain('英语 [原始]');
    expect(markup).toContain('英语 (CC)');
    expect(markup).toContain('Netflix 官方简体中文');
    expect(markup).toContain('Google 翻译');
    expect(markup).toContain('官方双语');
    expect(markup).toContain('字幕链路');
    expect(markup).toContain('字幕已解析，可显示双语');
    for (const label of [
      '开启双语字幕',
      '暂停当前标签页',
      '显示英文字幕',
      '显示中文字幕',
      '字幕来源',
      '字幕上下顺序',
      '英文字体',
      '中文字体',
      '英文字号',
      '中文字号',
      '英文粗细',
      '中文粗细',
      '英文颜色',
      '中文颜色',
      '字幕阴影',
      '字幕行距',
      '单行长度',
      '字幕垂直位置',
      '字幕背景不透明度',
      '关闭 SubTwin 控制台',
    ]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).not.toContain('aria-label="启用 SubTwin"');
    expect(markup).toContain('Netflix 原生双语');
    expect(markup).toContain('Google 翻译');
    expect(markup).toContain('DeepSeek 翻译（需先配置 Key）');
  });

  it('changes the pause button accessible name when the page is paused', () => {
    const markup = renderToStaticMarkup(
      <PageControlSurface
        expanded
        model={{ ...model, paused: true }}
        position={{ x: 1200, y: 600 }}
        onAppearanceChange={vi.fn()}
        onEnabledChange={vi.fn()}
        onExpandedChange={vi.fn()}
        onPausedChange={vi.fn()}
        onPositionChange={vi.fn()}
        onProviderChange={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="继续当前页"');
    expect(markup).not.toContain('aria-label="暂停当前标签页"');
  });

  it('emits the edited value from every live subtitle control', () => {
    const onAppearanceChange = vi.fn();
    const onEnabledChange = vi.fn();
    const onPausedChange = vi.fn();
    const onProviderChange = vi.fn();
    const controls = collectHostElements(PageControlSurface({
      expanded: true,
      model,
      position: { x: 1200, y: 600 },
      onAppearanceChange,
      onEnabledChange,
      onExpandedChange: vi.fn(),
      onPausedChange,
      onPositionChange: vi.fn(),
      onProviderChange,
    }));

    changeChecked(findControl(controls, '开启双语字幕'), false);
    click(findControl(controls, '暂停当前标签页'));
    changeChecked(findControl(controls, '显示英文字幕'), false);
    changeChecked(findControl(controls, '显示中文字幕'), false);
    changeValue(findControl(controls, '字幕来源'), 'deepseek');
    changeValue(findControl(controls, '字幕上下顺序'), 'chinese-first');
    changeValue(findControl(controls, '英文字体'), 'mono');
    changeValue(findControl(controls, '中文字体'), 'serif');
    changeValue(findControl(controls, '英文字号'), '41');
    changeValue(findControl(controls, '中文字号'), '39');
    changeValue(findControl(controls, '英文粗细'), '800');
    changeValue(findControl(controls, '中文粗细'), '600');
    changeValue(findControl(controls, '英文颜色'), '#123456');
    changeValue(findControl(controls, '中文颜色'), '#abcdef');
    changeValue(findControl(controls, '字幕阴影'), 'strong');
    changeValue(findControl(controls, '字幕行距'), '17');
    changeValue(findControl(controls, '单行长度'), '100');
    changeValue(findControl(controls, '字幕垂直位置'), '63');
    changeValue(findControl(controls, '字幕背景不透明度'), '0.65');

    expect(onEnabledChange).toHaveBeenCalledWith(false);
    expect(onPausedChange).toHaveBeenCalledWith(true);
    expect(onProviderChange).toHaveBeenCalledWith('deepseek');
    expect(onAppearanceChange.mock.calls.map(([appearance]) => appearance)).toEqual([
      { ...model.settings.appearance, english: { ...model.settings.appearance.english, visible: false } },
      { ...model.settings.appearance, chinese: { ...model.settings.appearance.chinese, visible: false } },
      { ...model.settings.appearance, order: 'chinese-first' },
      { ...model.settings.appearance, english: { ...model.settings.appearance.english, fontFamily: 'mono' } },
      { ...model.settings.appearance, chinese: { ...model.settings.appearance.chinese, fontFamily: 'serif' } },
      { ...model.settings.appearance, english: { ...model.settings.appearance.english, fontSizePx: 41 } },
      { ...model.settings.appearance, chinese: { ...model.settings.appearance.chinese, fontSizePx: 39 } },
      { ...model.settings.appearance, english: { ...model.settings.appearance.english, fontWeight: 800 } },
      { ...model.settings.appearance, chinese: { ...model.settings.appearance.chinese, fontWeight: 600 } },
      { ...model.settings.appearance, english: { ...model.settings.appearance.english, color: '#123456' } },
      { ...model.settings.appearance, chinese: { ...model.settings.appearance.chinese, color: '#ABCDEF' } },
      { ...model.settings.appearance, shadow: 'strong' },
      { ...model.settings.appearance, lineSpacingPx: 17 },
      { ...model.settings.appearance, maxLineWidthPercent: 100 },
      { ...model.settings.appearance, verticalOffsetPercent: 63 },
      { ...model.settings.appearance, backgroundOpacity: 0.65 },
    ]);
  });

  it('clamps dragged launcher coordinates inside the visible viewport', () => {
    expect(clampFloatingPosition(
      { x: -50, y: 999 },
      { width: 800, height: 600 },
      { width: 52, height: 52 },
    )).toEqual({ x: 12, y: 456 });
    expect(clampFloatingPosition(
      { x: 300, y: 200 },
      { width: 800, height: 600 },
      { width: 52, height: 52 },
    )).toEqual({ x: 300, y: 200 });
  });

  it('keeps the host transparent while making only the launcher and panel interactive', () => {
    expect(controlCss).toContain(':host');
    expect(controlCss).toContain('pointer-events: none');
    expect(controlCss).toContain('.subtwin-controls__launcher');
    expect(controlCss).toContain('.subtwin-controls__panel');
    expect(controlCss).toMatch(/\.subtwin-controls__launcher[\s\S]*pointer-events:\s*auto/iu);
    expect(controlCss).toMatch(/\.subtwin-controls__panel[\s\S]*pointer-events:\s*auto/iu);
    expect(controlCss).toContain('width: min(440px, calc(100vw - 28px))');
    expect(controlCss).toMatch(/\.subtwin-controls__range input[\s\S]*min-height:\s*28px/iu);
    expect(controlCss).not.toMatch(/animation:\s*[^n]/iu);
  });

  it('reports panel expansion so subtitle drag mode can follow it', () => {
    const document = new ControlDocumentFixture();
    const renderRoot = new ControlRenderRootFixture();
    const onExpandedChange = vi.fn();
    const mount = mountPageControlSurface({
      model,
      onAppearanceChange: vi.fn(),
      onEnabledChange: vi.fn(),
      onExpandedChange,
      onPausedChange: vi.fn(),
      onProviderChange: vi.fn(),
      document,
      viewport: { width: 1280, height: 720, storage: new MemorySessionStorage() },
      createRenderRoot: () => renderRoot,
    });

    const rendered = renderRoot.rendered.at(-1) as {
      readonly props: { readonly onExpandedChange: (expanded: boolean) => void };
    };
    rendered.props.onExpandedChange(true);
    expect(onExpandedChange).toHaveBeenCalledWith(true);

    mount.dispose();
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
  });

  it('mounts in an isolated shadow root, follows fullscreen and disposes every resource', () => {
    const document = new ControlDocumentFixture();
    const renderRoot = new ControlRenderRootFixture();
    const storage = new MemorySessionStorage();
    const mount = mountPageControlSurface({
      model,
      onAppearanceChange: vi.fn(),
      onEnabledChange: vi.fn(),
      onPausedChange: vi.fn(),
      onProviderChange: vi.fn(),
      document,
      viewport: { width: 1280, height: 720, storage },
      createRenderRoot: () => renderRoot,
    });

    expect(document.documentElement.children).toHaveLength(1);
    const host = document.documentElement.children[0]!;
    expect(host.id).toBe('subtwin-page-controls');
    expect(host.shadowRoot?.children).toHaveLength(2);
    expect(renderRoot.rendered).toHaveLength(1);
    expect(document.listenerCount).toBe(1);

    const fullscreen = new ControlNodeFixture();
    fullscreen.isConnected = true;
    document.fullscreenElement = fullscreen;
    document.emitFullscreenChange();
    expect(fullscreen.children).toEqual([host]);

    mount.update({ ...model, paused: true });
    expect(renderRoot.rendered).toHaveLength(3);
    mount.dispose();
    expect(renderRoot.unmountCount).toBe(1);
    expect(document.listenerCount).toBe(0);
    expect(host.isConnected).toBe(false);
  });

  it('reclamps and rerenders a saved launcher position when fullscreen shrinks the viewport', () => {
    const document = new ControlDocumentFixture();
    const renderRoot = new ControlRenderRootFixture();
    const viewport = {
      width: 1280,
      height: 720,
      storage: new MemorySessionStorage(),
    };
    const mount = mountPageControlSurface({
      model,
      onAppearanceChange: vi.fn(),
      onEnabledChange: vi.fn(),
      onPausedChange: vi.fn(),
      onProviderChange: vi.fn(),
      document,
      viewport,
      createRenderRoot: () => renderRoot,
    });

    viewport.height = 480;
    const fullscreen = new ControlNodeFixture();
    fullscreen.isConnected = true;
    document.fullscreenElement = fullscreen;
    document.emitFullscreenChange();

    const rendered = renderRoot.rendered.at(-1) as {
      readonly props: { readonly position: { readonly x: number; readonly y: number } };
    };
    expect(rendered.props.position).toEqual({ x: 1204, y: 336 });
    expect(renderRoot.rendered).toHaveLength(2);

    mount.dispose();
  });

  it('fully disposes the previous singleton before remounting in the same document', () => {
    const document = new ControlDocumentFixture();
    const roots: ControlRenderRootFixture[] = [];
    const options = {
      model,
      onAppearanceChange: vi.fn(),
      onEnabledChange: vi.fn(),
      onPausedChange: vi.fn(),
      onProviderChange: vi.fn(),
      document,
      viewport: {
        width: 1280,
        height: 720,
        storage: new MemorySessionStorage(),
      },
      createRenderRoot: () => {
        const root = new ControlRenderRootFixture();
        roots.push(root);
        return root;
      },
    };

    const first = mountPageControlSurface(options);
    const second = mountPageControlSurface(options);

    expect(roots).toHaveLength(2);
    expect(roots[0]?.unmountCount).toBe(1);
    expect(document.listenerCount).toBe(1);
    expect(document.documentElement.children).toHaveLength(1);

    const fullscreen = new ControlNodeFixture();
    fullscreen.isConnected = true;
    document.fullscreenElement = fullscreen;
    document.emitFullscreenChange();
    expect(fullscreen.children).toHaveLength(1);

    first.dispose();
    expect(document.listenerCount).toBe(1);
    expect(fullscreen.children).toHaveLength(1);
    second.dispose();
    expect(document.listenerCount).toBe(0);
    expect(fullscreen.children).toHaveLength(0);
  });

  it('cleans up the host and render root when the first append fails', () => {
    const document = new ControlDocumentFixture();
    document.documentElement.throwOnAppend = true;
    const renderRoot = new ControlRenderRootFixture();

    expect(() => mountPageControlSurface({
      model,
      onAppearanceChange: vi.fn(),
      onEnabledChange: vi.fn(),
      onPausedChange: vi.fn(),
      onProviderChange: vi.fn(),
      document,
      viewport: { width: 1280, height: 720, storage: new MemorySessionStorage() },
      createRenderRoot: () => renderRoot,
    })).toThrow('page control surface');

    expect(renderRoot.unmountCount).toBe(1);
    expect(document.listenerCount).toBe(0);
    expect(document.documentElement.children).toHaveLength(0);
  });
});

interface HostElementProps {
  readonly 'aria-label'?: string;
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onChange?: (event: {
    readonly currentTarget: {
      readonly checked?: boolean;
      readonly value?: string;
    };
  }) => void;
  readonly onInput?: (event: {
    readonly currentTarget: {
      readonly value?: string;
    };
  }) => void;
}

type HostElement = ReactElement<HostElementProps, string>;

function collectHostElements(node: ReactNode): readonly HostElement[] {
  const elements: HostElement[] = [];
  const visit = (candidate: ReactNode): void => {
    Children.forEach(candidate, (child) => {
      if (!isValidElement(child)) return;
      if (typeof child.type === 'function') {
        const component = child.type as (
          props: Record<string, unknown>,
        ) => ReactNode;
        visit(component(child.props as Record<string, unknown>));
        return;
      }
      const props = child.props as HostElementProps;
      if (typeof child.type === 'string') {
        elements.push(child as HostElement);
      }
      visit(props.children);
    });
  };
  visit(node);
  return elements;
}

function findControl(
  controls: readonly HostElement[],
  label: string,
): HostElement {
  const control = controls.find((candidate) => candidate.props['aria-label'] === label);
  if (control === undefined) throw new Error(`Missing control: ${label}`);
  return control;
}

function click(control: HostElement): void {
  if (control.props.onClick === undefined) throw new Error('Control is not clickable.');
  control.props.onClick();
}

function changeChecked(control: HostElement, checked: boolean): void {
  if (control.props.onChange === undefined) throw new Error('Control is not changeable.');
  control.props.onChange({ currentTarget: { checked } });
}

function changeValue(control: HostElement, value: string): void {
  const handler = control.props.onInput ?? control.props.onChange;
  if (handler === undefined) throw new Error('Control is not changeable.');
  handler({ currentTarget: { value } });
}

class MemorySessionStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class ControlRenderRootFixture implements PageControlRenderRoot {
  readonly rendered: ReactNode[] = [];
  unmountCount = 0;

  render(node: ReactNode): void {
    this.rendered.push(node);
  }

  unmount(): void {
    this.unmountCount += 1;
  }
}

class ControlNodeFixture implements PageControlNode {
  id = '';
  textContent: string | null = null;
  isConnected = false;
  throwOnAppend = false;
  readonly children: ControlNodeFixture[] = [];
  shadowRoot: ControlNodeFixture | null = null;
  private parent: ControlNodeFixture | undefined;

  append(...nodes: readonly PageControlNode[]): void {
    if (this.throwOnAppend) throw new Error('append failed');
    for (const candidate of nodes) {
      const node = candidate as ControlNodeFixture;
      node.remove();
      node.parent = this;
      node.isConnected = true;
      this.children.push(node);
    }
  }

  attachShadow(): PageControlNode {
    const shadow = new ControlNodeFixture();
    shadow.isConnected = true;
    this.shadowRoot = shadow;
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

class ControlDocumentFixture implements PageControlDocument {
  readonly documentElement = new ControlNodeFixture();
  fullscreenElement: ControlNodeFixture | null = null;
  private readonly nodes: ControlNodeFixture[] = [];
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.documentElement.isConnected = true;
  }

  createElement(): ControlNodeFixture {
    const node = new ControlNodeFixture();
    this.nodes.push(node);
    return node;
  }

  getElementById(id: string): ControlNodeFixture | null {
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
