import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { runtimeStatusMessage, type RuntimeStatus } from '../app/status';
import type {
  RuntimeSettingsState,
  SubtitleAppearanceSettings,
  SubtitleFontFamily,
  SubtitleLanguageAppearance,
  TranslationProviderSetting,
} from '../storage/schema';
import controlCss from './page-control-surface.css?raw';

export const PAGE_CONTROL_SURFACE_HOST_ID = 'subtwin-page-controls';
const POSITION_STORAGE_KEY = 'subtwin.page-controls.position.v1';
const VIEWPORT_MARGIN = 12;
const VIEWPORT_BOTTOM_CLEARANCE = 92;

export interface FloatingPosition {
  readonly x: number;
  readonly y: number;
}

export interface PagePlaybackMetadata {
  readonly title: string;
  readonly playback: 'paused' | 'playing' | 'unavailable';
  readonly audioTrack: string;
  readonly subtitleTrack: string;
}

export interface PageCatalogSummary {
  readonly authority: 'authoritative' | 'provisional' | 'unknown';
  readonly englishTrack: string;
  readonly chineseTrack: string;
  readonly officialChinese: boolean;
}

export interface PageControlSurfaceModel {
  readonly settings: RuntimeSettingsState;
  readonly paused: boolean;
  readonly pipeline: string;
  readonly saveState: 'error' | 'idle' | 'saved' | 'saving';
  readonly status: RuntimeStatus;
  readonly metadata: PagePlaybackMetadata;
  readonly catalog: PageCatalogSummary;
}

export interface PageControlSurfaceProps {
  readonly expanded: boolean;
  readonly model: PageControlSurfaceModel;
  readonly position: FloatingPosition;
  readonly onAppearanceChange: (appearance: SubtitleAppearanceSettings) => void;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onPausedChange: (paused: boolean) => void;
  readonly onPositionChange: (position: FloatingPosition) => void;
  readonly onProviderChange: (provider: TranslationProviderSetting) => void;
}

interface DragState {
  readonly origin: FloatingPosition;
  readonly pointer: FloatingPosition;
  moved: boolean;
}

export function PageControlSurface(props: PageControlSurfaceProps): ReactNode {
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const appearance = props.model.settings.appearance;

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      origin: props.position,
      pointer: { x: event.clientX, y: event.clientY },
      moved: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (current === null) return;
    const dx = event.clientX - current.pointer.x;
    const dy = event.clientY - current.pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) current.moved = true;
    props.onPositionChange(clampFloatingPosition(
      { x: current.origin.x + dx, y: current.origin.y + dy },
      { width: window.innerWidth, height: window.innerHeight },
      { width: 52, height: 52 },
    ));
  };
  const onPointerUp = (): void => {
    suppressClick.current = drag.current?.moved === true;
    drag.current = null;
  };
  const toggleExpanded = (): void => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    props.onExpandedChange(!props.expanded);
  };
  const launcherStyle: CSSProperties = {
    left: `${props.position.x}px`,
    top: `${props.position.y}px`,
  };

  const settings = props.model.settings;
  const sourceHint = providerHint(props.model);

  return (
    <div className="subtwin-controls">
      <button
        aria-label={props.expanded ? '移动 SubTwin 悬浮按钮' : '打开 SubTwin 控制台'}
        className="subtwin-controls__launcher"
        data-subtwin-control="launcher"
        onClick={toggleExpanded}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerCancel={onPointerUp}
        onPointerUp={onPointerUp}
        style={launcherStyle}
        type="button"
      >
        <span aria-hidden="true">双</span>
        <span className="subtwin-controls__launcher-state" data-state={launcherState(props.model)} />
      </button>

      {props.expanded ? (
        <aside
          aria-label="SubTwin Netflix 字幕控制台"
          className="subtwin-controls__panel"
          data-subtwin-control="panel"
        >
          <header className="subtwin-controls__header">
            <div className="subtwin-controls__brand">
              <span aria-hidden="true" className="subtwin-controls__mark">双</span>
              <div>
                <h2>SubTwin</h2>
                <p>Netflix 中英双语字幕</p>
              </div>
            </div>
            <div className="subtwin-controls__header-actions">
              <label className="subtwin-controls__switch" title="开启或关闭双语字幕">
                <input
                  aria-label="开启双语字幕"
                  checked={settings.enabled}
                  onChange={(event) => props.onEnabledChange(event.currentTarget.checked)}
                  role="switch"
                  type="checkbox"
                />
                <span aria-hidden="true" />
              </label>
              <button
                aria-label="关闭 SubTwin 控制台"
                className="subtwin-controls__icon-button"
                onClick={() => props.onExpandedChange(false)}
                type="button"
              >×</button>
            </div>
          </header>

          <section
            aria-live="polite"
            className="subtwin-controls__status"
            data-mode={statusTone(props.model)}
          >
            <span className="subtwin-controls__status-dot" />
            <div>
              <strong>{props.model.paused ? '本页已暂停' : shortStatus(props.model.status)}</strong>
              <p>{props.model.paused
                ? '已恢复 Netflix 原字幕，点击下方"继续当前页"重新显示双语。'
                : runtimeStatusMessage(props.model.status)}</p>
            </div>
          </section>

          <section className="subtwin-controls__card" aria-label="字幕来源设置">
            <h3>字幕来源</h3>
            <Segmented
              label="字幕来源"
              onChange={(provider) => props.onProviderChange(provider as TranslationProviderSetting)}
              options={[
                { value: 'unset', label: 'Netflix 原生双语', title: '原生双语', detail: '官方中文' },
                { value: 'google-free', label: 'Google 翻译', title: 'Google', detail: '免费翻译' },
                {
                  value: 'deepseek',
                  label: settings.deepseekKeyReady ? 'DeepSeek 翻译' : 'DeepSeek 翻译（需先配置 Key）',
                  title: 'DeepSeek',
                  detail: settings.deepseekKeyReady ? '上下文翻译' : '需配置 Key',
                },
              ]}
              value={settings.provider}
            />
            {sourceHint === null ? null : (
              <p className="subtwin-controls__hint" data-tone={sourceHint.tone}>{sourceHint.text}</p>
            )}
          </section>

          <section className="subtwin-controls__card" aria-label="字幕显示">
            <h3>显示</h3>
            <div className="subtwin-controls__chips">
              <Chip
                checked={appearance.english.visible}
                label="显示英文字幕"
                text="英文"
                onChange={(visible) => props.onAppearanceChange({
                  ...appearance,
                  english: { ...appearance.english, visible },
                })}
              />
              <Chip
                checked={appearance.chinese.visible}
                label="显示中文字幕"
                text="中文"
                onChange={(visible) => props.onAppearanceChange({
                  ...appearance,
                  chinese: { ...appearance.chinese, visible },
                })}
              />
            </div>
            <Segmented
              compact
              label="字幕上下顺序"
              onChange={(order) => props.onAppearanceChange({
                ...appearance,
                order: order as SubtitleAppearanceSettings['order'],
              })}
              options={[
                { value: 'english-first', label: '英文在上', title: '英文在上' },
                { value: 'chinese-first', label: '中文在上', title: '中文在上' },
              ]}
              value={appearance.order}
            />
          </section>

          <details className="subtwin-controls__group">
            <summary>文字样式</summary>
            <div className="subtwin-controls__columns">
              <LanguageControls
                appearance={appearance.english}
                language="英文"
                onChange={(english) => props.onAppearanceChange({ ...appearance, english })}
              />
              <LanguageControls
                appearance={appearance.chinese}
                language="中文"
                onChange={(chinese) => props.onAppearanceChange({ ...appearance, chinese })}
              />
            </div>
          </details>

          <details className="subtwin-controls__group">
            <summary>位置与背景</summary>
            <div className="subtwin-controls__stack">
              <Segmented
                compact
                label="字幕阴影"
                onChange={(shadow) => props.onAppearanceChange({
                  ...appearance,
                  shadow: shadow as SubtitleAppearanceSettings['shadow'],
                })}
                options={[
                  { value: 'none', label: '无阴影', title: '无阴影' },
                  { value: 'soft', label: '柔和阴影', title: '柔和' },
                  { value: 'strong', label: '强阴影', title: '强' },
                ]}
                value={appearance.shadow}
              />
              <RangeField label="字幕垂直位置" text="垂直位置" max={80} min={0} step={1} suffix="%"
                value={appearance.verticalOffsetPercent}
                onChange={(verticalOffsetPercent) => props.onAppearanceChange({ ...appearance, verticalOffsetPercent })} />
              <RangeField label="字幕行距" text="行距" max={48} min={0} step={1} suffix="px"
                value={appearance.lineSpacingPx}
                onChange={(lineSpacingPx) => props.onAppearanceChange({ ...appearance, lineSpacingPx })} />
              <RangeField label="单行长度" text="单行长度" max={100} min={50} step={1} suffix="%"
                value={appearance.maxLineWidthPercent}
                onChange={(maxLineWidthPercent) => props.onAppearanceChange({
                  ...appearance,
                  maxLineWidthPercent,
                })} />
              <RangeField label="字幕背景不透明度" text="背景不透明度" max={1} min={0} step={0.05} suffix=""
                value={appearance.backgroundOpacity}
                onChange={(backgroundOpacity) => props.onAppearanceChange({ ...appearance, backgroundOpacity })} />
              <p className="subtwin-controls__tip">控制台打开时，可以直接上下拖动画面里的字幕。</p>
            </div>
          </details>

          <details className="subtwin-controls__group">
            <summary>诊断信息</summary>
            <dl className="subtwin-controls__metadata" aria-label="当前播放信息">
              <Metadata label="影片" value={props.model.metadata.title} />
              <Metadata label="播放" value={playbackLabel(props.model.metadata.playback)} />
              <Metadata label="音轨" value={props.model.metadata.audioTrack} />
              <Metadata label="原字幕" value={props.model.metadata.subtitleTrack} />
              <Metadata label="英文字幕" value={props.model.catalog.englishTrack} />
              <Metadata label="中文字幕" value={props.model.catalog.chineseTrack} />
              <Metadata
                label="官方中文"
                value={props.model.catalog.officialChinese
                  ? 'Netflix 官方简体中文'
                  : '未发现官方简体中文'}
              />
              <Metadata label="字幕链路" value={props.model.pipeline} />
            </dl>
          </details>

          <footer className="subtwin-controls__footer" data-save-state={props.model.saveState}>
            <button
              aria-label={props.model.paused ? '继续当前页' : '暂停当前标签页'}
              aria-pressed={props.model.paused}
              className="subtwin-controls__pause"
              disabled={!settings.enabled}
              onClick={() => props.onPausedChange(!props.model.paused)}
              type="button"
            >
              {props.model.paused ? '继续当前页' : '暂停当前页'}
            </button>
            <span>{saveStateLabel(props.model.saveState)}</span>
          </footer>
        </aside>
      ) : null}
    </div>
  );
}

interface SegmentedOption {
  readonly value: string;
  readonly label: string;
  readonly title: string;
  readonly detail?: string;
}

function Segmented(props: {
  readonly compact?: boolean;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SegmentedOption[];
  readonly value: string;
}): ReactNode {
  return (
    <div
      aria-label={props.label}
      className="subtwin-controls__segmented"
      data-compact={props.compact === true}
      role="radiogroup"
      style={{ '--subtwin-segments': props.options.length } as CSSProperties}
    >
      {props.options.map((option) => (
        <button
          aria-checked={option.value === props.value}
          aria-label={option.label}
          key={option.value}
          onClick={() => {
            if (option.value !== props.value) props.onChange(option.value);
          }}
          role="radio"
          type="button"
        >
          <span>{option.title}</span>
          {option.detail === undefined ? null : <small>{option.detail}</small>}
        </button>
      ))}
    </div>
  );
}

function Chip(props: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
  readonly text: string;
}): ReactNode {
  return (
    <label className="subtwin-controls__chip">
      <input aria-label={props.label} checked={props.checked} type="checkbox"
        onChange={(event) => props.onChange(event.currentTarget.checked)} />
      <span>{props.text}</span>
    </label>
  );
}

function LanguageControls(props: {
  readonly appearance: SubtitleLanguageAppearance;
  readonly language: '中文' | '英文';
  readonly onChange: (appearance: SubtitleLanguageAppearance) => void;
}): ReactNode {
  return (
    <section className="subtwin-controls__language" aria-label={`${props.language}字幕样式`}>
      <h4>{props.language}</h4>
      <label className="subtwin-controls__field">
        <span>字体</span>
        <select aria-label={`${props.language}字体`} value={props.appearance.fontFamily}
          onChange={(event) => props.onChange({
            ...props.appearance,
            fontFamily: event.currentTarget.value as SubtitleFontFamily,
          })}>
          {FONT_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>
      <RangeField label={`${props.language}字号`} text="字号" max={72} min={12} step={1} suffix="px"
        value={props.appearance.fontSizePx}
        onChange={(fontSizePx) => props.onChange({ ...props.appearance, fontSizePx })} />
      <RangeField label={`${props.language}粗细`} text="粗细" max={900} min={100} step={100} suffix=""
        value={props.appearance.fontWeight}
        onChange={(fontWeight) => props.onChange({ ...props.appearance, fontWeight })} />
      <label className="subtwin-controls__color">
        <span>颜色</span>
        <input aria-label={`${props.language}颜色`} type="color" value={props.appearance.color}
          onChange={(event) => props.onChange({
            ...props.appearance,
            color: event.currentTarget.value.toUpperCase(),
          })} />
        <code>{props.appearance.color.toUpperCase()}</code>
      </label>
    </section>
  );
}

const FONT_OPTIONS: readonly (readonly [SubtitleFontFamily, string])[] = [
  ['sans', '清晰无衬线'],
  ['rounded', '圆体'],
  ['system', '系统字体'],
  ['serif', '衬线体'],
  ['mono', '等宽体'],
];

function RangeField(props: {
  readonly label: string;
  readonly text: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly step: number;
  readonly suffix: string;
  readonly value: number;
}): ReactNode {
  return (
    <label className="subtwin-controls__range">
      <span>{props.text}</span>
      <output>{props.value}{props.suffix}</output>
      <input aria-label={props.label} max={props.max} min={props.min} step={props.step}
        type="range" value={props.value}
        onInput={(event) => props.onChange(Number(event.currentTarget.value))} />
    </label>
  );
}

function Metadata(props: { readonly label: string; readonly value: string }): ReactNode {
  // Netflix 播放器控件隐藏时读不到这些信息，占位文字只会让面板看起来像出错。
  if (props.value.trim().length === 0 || props.value.startsWith('等待')) return null;
  return <div className="subtwin-controls__metadata-row"><dt>{props.label}</dt><dd>{props.value}</dd></div>;
}

function statusTone(model: PageControlSurfaceModel): string {
  if (!model.settings.enabled || model.paused) return 'idle';
  if (model.status.mode === 'error') return 'error';
  if (model.status.mode === 'discovering' || model.status.mode === 'unset') return 'pending';
  return 'active';
}

function providerHint(
  model: PageControlSurfaceModel,
): { readonly tone: 'info' | 'warn'; readonly text: string } | null {
  if (model.catalog.authority !== 'authoritative') return null;
  const provider = model.settings.provider;
  if (provider === 'unset') {
    return model.catalog.officialChinese
      ? { tone: 'info', text: '本片有 Netflix 官方简体中文，双语字幕无需调用翻译。' }
      : { tone: 'warn', text: '本片没有官方简体中文，原生双语只能显示英文；改用 Google 或 DeepSeek 即可显示中英双语。' };
  }
  if (provider === 'deepseek' && !model.settings.deepseekKeyReady) {
    return { tone: 'warn', text: '还没有配置 DeepSeek API Key，请在扩展设置页填写。' };
  }
  return model.catalog.officialChinese
    ? { tone: 'info', text: '本片也有官方简体中文，可切换到"原生双语"免去翻译。' }
    : null;
}

export function clampFloatingPosition(
  position: FloatingPosition,
  viewport: { readonly width: number; readonly height: number },
  launcher: { readonly width: number; readonly height: number },
): FloatingPosition {
  return {
    x: Math.min(
      Math.max(VIEWPORT_MARGIN, viewport.width - launcher.width - VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, position.x),
    ),
    y: Math.min(
      Math.max(
        VIEWPORT_MARGIN,
        viewport.height - launcher.height - VIEWPORT_BOTTOM_CLEARANCE,
      ),
      Math.max(VIEWPORT_MARGIN, position.y),
    ),
  };
}

export interface PageControlSurfaceMount {
  update(model: PageControlSurfaceModel): void;
  dispose(): void;
}

export interface PageControlNode {
  id: string;
  textContent: string | null;
  readonly isConnected: boolean;
  append(...nodes: readonly PageControlNode[]): void;
  attachShadow?(init: { readonly mode: 'open' }): PageControlNode;
  remove(): void;
}

export interface PageControlDocument {
  readonly documentElement: PageControlNode;
  readonly fullscreenElement: PageControlNode | null;
  createElement(tagName: 'div' | 'style'): PageControlNode;
  getElementById(id: string): PageControlNode | null;
  addEventListener(type: 'fullscreenchange', listener: () => void): void;
  removeEventListener(type: 'fullscreenchange', listener: () => void): void;
}

export interface PageControlStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PageControlViewport {
  readonly width: number;
  readonly height: number;
  readonly storage: PageControlStorage;
}

export interface PageControlRenderRoot {
  render(node: ReactNode): void;
  unmount(): void;
}

export interface MountPageControlSurfaceOptions {
  readonly model: PageControlSurfaceModel;
  readonly onAppearanceChange: (appearance: SubtitleAppearanceSettings) => void;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly onPausedChange: (paused: boolean) => void;
  readonly onProviderChange: (provider: TranslationProviderSetting) => void;
  readonly document?: PageControlDocument;
  readonly viewport?: PageControlViewport;
  readonly createRenderRoot?: (
    container: PageControlNode,
  ) => PageControlRenderRoot;
}

const ACTIVE_CONTROL_MOUNTS = new WeakMap<object, PageControlSurfaceMount>();

export function mountPageControlSurface(options: MountPageControlSurfaceOptions): PageControlSurfaceMount {
  const controlDocument = resolveControlDocument(options.document);
  const viewport = resolveViewport(options.viewport);
  ACTIVE_CONTROL_MOUNTS.get(controlDocument)?.dispose();
  controlDocument.getElementById(PAGE_CONTROL_SURFACE_HOST_ID)?.remove();
  const host = controlDocument.createElement('div');
  host.id = PAGE_CONTROL_SURFACE_HOST_ID;
  let root: PageControlRenderRoot | undefined;
  let listenerAttached = false;
  let model = options.model;
  let expanded = false;
  let position = readPosition(viewport);
  let disposed = false;

  const moveToFullscreenRoot = (): void => {
    if (disposed) return;
    (controlDocument.fullscreenElement ?? controlDocument.documentElement).append(host);
    if (!host.isConnected) throw new Error('Detached SubTwin page control host.');
  };
  const handleFullscreenChange = (): void => {
    try {
      moveToFullscreenRoot();
    } catch {
      try {
        controlDocument.documentElement.append(host);
      } catch {
        // The control surface is optional and must not affect playback.
      }
    }
    render();
  };
  const render = (): void => {
    position = clampFloatingPosition(
      position,
      { width: viewport.width, height: viewport.height },
      { width: 52, height: 52 },
    );
    root?.render(<PageControlSurface
      expanded={expanded}
      model={model}
      onAppearanceChange={options.onAppearanceChange}
      onEnabledChange={options.onEnabledChange}
      onExpandedChange={(next) => {
        expanded = next;
        options.onExpandedChange?.(next);
        render();
      }}
      onPausedChange={options.onPausedChange}
      onPositionChange={(next) => { position = next; writePosition(next, viewport); render(); }}
      onProviderChange={options.onProviderChange}
      position={position}
    />);
  };

  try {
    const shadow = host.attachShadow?.({ mode: 'open' });
    if (shadow === undefined) throw new Error('Shadow DOM is unavailable.');
    const style = controlDocument.createElement('style');
    style.textContent = controlCss;
    const container = controlDocument.createElement('div');
    shadow.append(style, container);
    root = (options.createRenderRoot ?? createBrowserControlRoot)(container);
    moveToFullscreenRoot();
    controlDocument.addEventListener('fullscreenchange', handleFullscreenChange);
    listenerAttached = true;
    render();
  } catch {
    if (listenerAttached) {
      controlDocument.removeEventListener('fullscreenchange', handleFullscreenChange);
    }
    try {
      root?.unmount();
    } catch {
      // Continue removing the failed host.
    }
    host.remove();
    throw new Error('Unable to mount SubTwin page control surface.');
  }

  const mount: PageControlSurfaceMount = {
    update(next) {
      if (disposed) return;
      model = next;
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (expanded) options.onExpandedChange?.(false);
      if (listenerAttached) {
        controlDocument.removeEventListener('fullscreenchange', handleFullscreenChange);
        listenerAttached = false;
      }
      try {
        root?.unmount();
      } catch {
        // Host cleanup must continue after a React teardown failure.
      } finally {
        try {
          host.remove();
        } finally {
          if (ACTIVE_CONTROL_MOUNTS.get(controlDocument) === mount) {
            ACTIVE_CONTROL_MOUNTS.delete(controlDocument);
          }
        }
      }
    },
  };
  ACTIVE_CONTROL_MOUNTS.set(controlDocument, mount);
  return mount;
}

function readPosition(viewport: PageControlViewport): FloatingPosition {
  const dimensions = { width: viewport.width, height: viewport.height };
  const fallback = clampFloatingPosition(
    { x: dimensions.width - 76, y: dimensions.height - 140 },
    dimensions,
    { width: 52, height: 52 },
  );
  try {
    const raw = viewport.storage.getItem(POSITION_STORAGE_KEY);
    if (raw === null) return fallback;
    const value = JSON.parse(raw) as { readonly x?: unknown; readonly y?: unknown };
    if (typeof value.x !== 'number' || typeof value.y !== 'number') return fallback;
    return clampFloatingPosition(
      { x: value.x, y: value.y }, dimensions, { width: 52, height: 52 },
    );
  } catch {
    return fallback;
  }
}

function writePosition(
  position: FloatingPosition,
  viewport: PageControlViewport,
): void {
  try {
    viewport.storage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Position persistence is optional and must not affect playback.
  }
}

function resolveControlDocument(
  injected: PageControlDocument | undefined,
): PageControlDocument {
  if (injected !== undefined) return injected;
  if (typeof document === 'undefined') {
    throw new Error('A document is required to mount page controls.');
  }
  return document as unknown as PageControlDocument;
}

function resolveViewport(
  injected: PageControlViewport | undefined,
): PageControlViewport {
  if (injected !== undefined) return injected;
  if (typeof window === 'undefined') {
    throw new Error('A window is required to mount page controls.');
  }
  return {
    get width() { return window.innerWidth; },
    get height() { return window.innerHeight; },
    storage: window.sessionStorage,
  };
}

function createBrowserControlRoot(
  container: PageControlNode,
): PageControlRenderRoot {
  const reactRoot = createRoot(container as unknown as Element);
  return {
    render: (node) => reactRoot.render(node),
    unmount: () => reactRoot.unmount(),
  };
}

function launcherState(model: PageControlSurfaceModel): string {
  if (!model.settings.enabled) return 'disabled';
  if (model.paused) return 'paused';
  return model.status.mode === 'error' ? 'error' : 'active';
}

function shortStatus(status: RuntimeStatus): string {
  if (status.mode === 'error') return '需要处理';
  if (status.mode === 'official') return '官方双语';
  if (status.mode === 'discovering') return '正在识别';
  if (status.mode === 'deepseek') return 'DeepSeek 翻译';
  if (status.mode === 'google-free') return 'Google 翻译';
  return '等待设置';
}


function playbackLabel(playback: PagePlaybackMetadata['playback']): string {
  if (playback === 'playing') return '播放中';
  if (playback === 'paused') return '已暂停';
  return '等待播放器';
}

function saveStateLabel(state: PageControlSurfaceModel['saveState']): string {
  if (state === 'saving') return '正在保存设置…';
  if (state === 'saved') return '设置已保存';
  if (state === 'error') return '设置保存失败';
  return '修改会自动保存';
}
