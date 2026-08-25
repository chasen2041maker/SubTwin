import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';

import type {
  SubtitleAppearanceSettings,
  SubtitleLanguageAppearance,
} from '../storage/schema';
import overlayCss from './subtitle-overlay.css?raw';

export const SUBTITLE_OVERLAY_HOST_ID = 'subtwin-subtitle-overlay';

export interface NormalizedActiveCueState {
  readonly english: string | null;
  readonly chinese: string | null;
}

export type SubtitleOverlayAppearance = SubtitleAppearanceSettings;
export type { SubtitleLanguageAppearance };

export interface SubtitleOverlayProps {
  readonly state: NormalizedActiveCueState;
  readonly appearance: SubtitleOverlayAppearance;
  readonly dragEnabled?: boolean;
  readonly onVerticalOffsetChange?: (verticalOffsetPercent: number) => void;
}

interface VisibleLine {
  readonly language: 'english' | 'chinese';
  readonly text: string;
}

type OverlayCssProperties = CSSProperties &
  Readonly<Record<`--subtwin-${string}`, string | number>>;

export function SubtitleOverlay({
  state,
  appearance,
  dragEnabled = false,
  onVerticalOffsetChange,
}: SubtitleOverlayProps): ReactNode {
  const drag = useRef<{ readonly startOffset: number; readonly startY: number } | null>(null);
  const [previewOffset, setPreviewOffset] = useState(() =>
    clamp(appearance.verticalOffsetPercent, 0, 80));
  useEffect(() => {
    if (drag.current === null) {
      setPreviewOffset(clamp(appearance.verticalOffsetPercent, 0, 80));
    }
  }, [appearance.verticalOffsetPercent]);

  const lines = selectVisibleLines(state, appearance);
  if (lines.length === 0) return null;

  const offsetAt = (clientY: number): number => verticalOffsetFromDrag(
    drag.current?.startOffset ?? previewOffset,
    drag.current?.startY ?? clientY,
    clientY,
    typeof window === 'undefined' ? 0 : window.innerHeight,
  );
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragEnabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startOffset: previewOffset, startY: event.clientY };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    event.preventDefault();
    setPreviewOffset(offsetAt(event.clientY));
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    event.preventDefault();
    const next = Math.round(offsetAt(event.clientY) * 2) / 2;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture can already be released when Netflix changes fullscreen roots.
    }
    setPreviewOffset(next);
    onVerticalOffsetChange?.(next);
  };
  const cancelDrag = (): void => {
    if (drag.current === null) return;
    drag.current = null;
    setPreviewOffset(clamp(appearance.verticalOffsetPercent, 0, 80));
  };

  const style: OverlayCssProperties = {
    '--subtwin-en-color': safeColor(appearance.english.color, '#FFFFFF'),
    '--subtwin-en-font': fontFamilyValue(appearance.english.fontFamily),
    '--subtwin-en-size': `${clamp(appearance.english.fontSizePx, 12, 72)}px`,
    '--subtwin-en-weight': clamp(appearance.english.fontWeight, 100, 900),
    '--subtwin-zh-color': safeColor(appearance.chinese.color, '#FFFFFF'),
    '--subtwin-zh-font': fontFamilyValue(appearance.chinese.fontFamily),
    '--subtwin-zh-size': `${clamp(appearance.chinese.fontSizePx, 12, 72)}px`,
    '--subtwin-zh-weight': clamp(appearance.chinese.fontWeight, 100, 900),
    '--subtwin-line-spacing': `${clamp(appearance.lineSpacingPx, 0, 48)}px`,
    '--subtwin-max-line-width': `${clamp(
      appearance.maxLineWidthPercent,
      50,
      100,
    )}vw`,
    '--subtwin-vertical-offset': clamp(
      previewOffset,
      0,
      80,
    ),
    '--subtwin-background-opacity': clamp(
      appearance.backgroundOpacity,
      0,
      1,
    ),
    '--subtwin-text-shadow': shadowValue(appearance.shadow),
  };

  return (
    <section
      aria-hidden="true"
      className="subtwin-overlay"
      data-drag-enabled={dragEnabled}
      data-order={appearance.order}
      style={style}
    >
      <div
        className="subtwin-overlay__cue"
        onPointerCancel={cancelDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
      >
        {lines.map((line) => (
          <div
            className={`subtwin-overlay__line subtwin-overlay__line--${line.language}`}
            data-language={line.language}
            key={line.language}
          >
            {line.text}
          </div>
        ))}
      </div>
    </section>
  );
}

export interface SubtitleOverlayNode {
  id: string;
  className: string;
  textContent: string | null;
  readonly isConnected: boolean;
  append(...nodes: readonly SubtitleOverlayNode[]): void;
  attachShadow?(init: { readonly mode: 'open' }): SubtitleOverlayNode;
  remove(): void;
}

export interface SubtitleOverlayDocument {
  readonly documentElement: SubtitleOverlayNode;
  readonly fullscreenElement: SubtitleOverlayNode | null;
  createElement(tagName: 'div' | 'style'): SubtitleOverlayNode;
  getElementById(id: string): SubtitleOverlayNode | null;
  addEventListener(type: 'fullscreenchange', listener: () => void): void;
  removeEventListener(type: 'fullscreenchange', listener: () => void): void;
}

export interface SubtitleOverlayHostObserver {
  observe(
    target: SubtitleOverlayNode,
    options: { readonly childList: true; readonly subtree: true },
  ): void;
  disconnect(): void;
}

export interface SubtitleOverlayRenderLifecycle {
  readonly onCommit: () => void;
  readonly onError: () => void;
}

export interface SubtitleOverlayRenderRoot {
  render(node: ReactNode, lifecycle: SubtitleOverlayRenderLifecycle): void;
  clear(): void;
  unmount(): void;
}

export interface NativeSubtitleVisibility {
  hide(): void;
  restore(): void;
}

export interface SubtitleOverlayMount {
  render(
    state: NormalizedActiveCueState,
    appearance: SubtitleOverlayAppearance,
  ): boolean;
  setNativeSubtitlesHidden(hidden: boolean): void;
  setDragMode(enabled: boolean): void;
  clear(): void;
  dispose(): void;
}

export interface MountSubtitleOverlayOptions {
  readonly document?: SubtitleOverlayDocument;
  readonly nativeVisibility: NativeSubtitleVisibility;
  readonly onVerticalOffsetChange?: (verticalOffsetPercent: number) => void;
  readonly createHostObserver?: (
    callback: () => void,
  ) => SubtitleOverlayHostObserver;
  readonly createRenderRoot?: (
    container: SubtitleOverlayNode,
  ) => SubtitleOverlayRenderRoot;
}

const ACTIVE_MOUNTS = new WeakMap<object, SubtitleOverlayMount>();

export function mountSubtitleOverlay(
  options: MountSubtitleOverlayOptions,
): SubtitleOverlayMount {
  const overlayDocument = resolveDocument(options.document);
  const existing = ACTIVE_MOUNTS.get(overlayDocument);
  if (existing !== undefined) return existing;

  let host: SubtitleOverlayNode | undefined;
  let root: SubtitleOverlayRenderRoot | undefined;
  let hostObserver: SubtitleOverlayHostObserver | undefined;
  let listenerAttached = false;
  let disposed = false;
  let nativeHidden = false;
  let nativeSuppressed = false;
  let renderedBilingual = false;
  let renderGeneration = 0;
  let dragEnabled = false;
  let lastAppearance: SubtitleOverlayAppearance | undefined;
  let lastState: NormalizedActiveCueState | undefined;

  const restoreNative = (force = false): void => {
    if (!force && (nativeSuppressed || renderedBilingual)) return;
    if (!nativeHidden && !force) return;
    nativeHidden = false;
    try {
      options.nativeVisibility.restore();
    } catch {
      // A best-effort restore must never break player teardown.
    }
  };

  const hideNative = (): void => {
    if (nativeHidden || disposed) return;
    try {
      options.nativeVisibility.hide();
      nativeHidden = true;
    } catch {
      restoreNative(true);
    }
  };

  const syncNativeVisibility = (): void => {
    if (nativeSuppressed || renderedBilingual) hideNative();
    else restoreNative();
  };

  const moveHostToFullscreenRoot = (): boolean => {
    if (disposed || host === undefined) return false;
    const target = overlayDocument.fullscreenElement ?? overlayDocument.documentElement;
    try {
      target.append(host);
    } catch {
      restoreNative();
      return false;
    }
    if (!host.isConnected) {
      restoreNative();
      return false;
    }
    return true;
  };

  const recoverDetachedHost = (): void => {
    if (disposed || host === undefined || host.isConnected) return;
    renderedBilingual = false;
    syncNativeVisibility();
    renderGeneration += 1;
    try {
      root?.clear();
    } catch {
      // Never reattach an overlay whose last committed content cannot be cleared.
      return;
    }
    moveHostToFullscreenRoot();
  };

  try {
    overlayDocument.getElementById(SUBTITLE_OVERLAY_HOST_ID)?.remove();
    host = overlayDocument.createElement('div');
    host.id = SUBTITLE_OVERLAY_HOST_ID;
    host.className = 'subtwin-overlay-host';
    const shadow = host.attachShadow?.({ mode: 'open' });
    if (shadow === undefined) {
      throw new Error('Shadow DOM is unavailable.');
    }

    const style = overlayDocument.createElement('style');
    style.textContent = overlayCss;
    const container = overlayDocument.createElement('div');
    container.className = 'subtwin-overlay-root';
    shadow.append(style, container);

    root = (options.createRenderRoot ?? createBrowserRenderRoot)(container);
    if (!moveHostToFullscreenRoot()) {
      throw new Error('Unable to attach subtitle overlay host.');
    }
    hostObserver = options.createHostObserver?.(recoverDetachedHost) ??
      createBrowserHostObserver(recoverDetachedHost);
    hostObserver?.observe(overlayDocument.documentElement, {
      childList: true,
      subtree: true,
    });
    overlayDocument.addEventListener(
      'fullscreenchange',
      moveHostToFullscreenRoot,
    );
    listenerAttached = true;
  } catch (error) {
    try {
      hostObserver?.disconnect();
    } catch {
      // Continue the fail-safe mount cleanup.
    }
    hostObserver = undefined;
    if (listenerAttached) {
      overlayDocument.removeEventListener(
        'fullscreenchange',
        moveHostToFullscreenRoot,
      );
      listenerAttached = false;
    }
    try {
      root?.unmount();
    } catch {
      // Continue the fail-safe cleanup even when React teardown fails.
    }
    try {
      host?.remove();
    } finally {
      restoreNative(true);
    }
    throw error;
  }

  const mountedRoot = root;
  const mountedHost = host;

  const mount: SubtitleOverlayMount = {
    render(state, appearance) {
      const visibleLines = selectVisibleLines(state, appearance);
      if (disposed || visibleLines.length === 0) {
        if (!disposed) mount.clear();
        return false;
      }
      const shouldHideNative = visibleLines.length >= 2;
      lastState = state;
      lastAppearance = appearance;

      if (!mountedHost.isConnected) {
        renderedBilingual = false;
        syncNativeVisibility();
        if (!moveHostToFullscreenRoot()) {
          try {
            mountedRoot.clear();
          } catch {
            // The detached host cannot be trusted as a render target.
          }
          return false;
        }
      }

      const generation = ++renderGeneration;
      try {
        mountedRoot.render(
          <SubtitleOverlay
            appearance={appearance}
            dragEnabled={dragEnabled}
            {...(options.onVerticalOffsetChange === undefined ? {} : {
              onVerticalOffsetChange: options.onVerticalOffsetChange,
            })}
            state={state}
          />,
          {
            onCommit: () => {
              if (disposed || generation !== renderGeneration) return;
              if (!mountedHost.isConnected) {
                renderedBilingual = false;
                syncNativeVisibility();
                return;
              }
              renderedBilingual = shouldHideNative;
              syncNativeVisibility();
            },
            onError: () => {
              if (!disposed && generation === renderGeneration) {
                renderedBilingual = false;
                syncNativeVisibility();
              }
            },
          },
        );
        return true;
      } catch {
        try {
          mountedRoot.clear();
        } catch {
          // A failed render is already being downgraded to native subtitles.
        }
        renderedBilingual = false;
        syncNativeVisibility();
        return false;
      }
    },

    setNativeSubtitlesHidden(hidden) {
      if (disposed || nativeSuppressed === hidden) return;
      nativeSuppressed = hidden;
      syncNativeVisibility();
    },

    setDragMode(enabled) {
      if (disposed || dragEnabled === enabled) return;
      dragEnabled = enabled;
      if (lastState !== undefined && lastAppearance !== undefined) {
        mount.render(lastState, lastAppearance);
      }
    },

    clear() {
      if (disposed) return;
      renderGeneration += 1;
      try {
        mountedRoot.clear();
      } catch {
        // Native subtitles remain the safe fallback when React cannot clear.
      } finally {
        renderedBilingual = false;
        syncNativeVisibility();
        lastState = undefined;
        lastAppearance = undefined;
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      nativeSuppressed = false;
      renderedBilingual = false;
      renderGeneration += 1;
      try {
        hostObserver?.disconnect();
      } catch {
        // Teardown continues even when an observer implementation fails.
      }
      hostObserver = undefined;
      if (listenerAttached) {
        overlayDocument.removeEventListener(
          'fullscreenchange',
          moveHostToFullscreenRoot,
        );
        listenerAttached = false;
      }
      try {
        mountedRoot.unmount();
      } catch {
        // Teardown continues so native subtitles and the host are restored.
      } finally {
        restoreNative();
        try {
          mountedHost.remove();
        } catch {
          // The player may already have removed the fullscreen subtree.
        } finally {
          ACTIVE_MOUNTS.delete(overlayDocument);
        }
      }
    },
  };

  ACTIVE_MOUNTS.set(overlayDocument, mount);
  return mount;
}

function createBrowserHostObserver(
  callback: () => void,
): SubtitleOverlayHostObserver | undefined {
  if (typeof MutationObserver === 'undefined') return undefined;
  return new MutationObserver(callback) as unknown as SubtitleOverlayHostObserver;
}

function selectVisibleLines(
  state: NormalizedActiveCueState,
  appearance: SubtitleOverlayAppearance,
): readonly VisibleLine[] {
  const english = normalizeLine(state.english);
  const chinese = normalizeLine(state.chinese);
  const lines: VisibleLine[] = [];

  if (appearance.english.visible && english !== null) {
    lines.push({ language: 'english', text: english });
  }
  if (appearance.chinese.visible && chinese !== null) {
    lines.push({ language: 'chinese', text: chinese });
  }
  if (appearance.order === 'chinese-first') lines.reverse();

  return lines;
}

function normalizeLine(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.replace(/\s+/gu, ' ').trim();
  return trimmed.length === 0 ? null : trimmed;
}

function safeColor(value: string, fallback: string): string {
  return /^#[0-9A-F]{6}$/iu.test(value) ? value.toUpperCase() : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function verticalOffsetFromDrag(
  startOffset: number,
  startY: number,
  currentY: number,
  viewportHeight: number,
): number {
  const safeStart = clamp(startOffset, 0, 80);
  if (!Number.isFinite(startY) || !Number.isFinite(currentY) ||
      !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return safeStart;
  }
  return clamp(
    safeStart - ((currentY - startY) / viewportHeight) * 100,
    0,
    80,
  );
}

function shadowValue(value: SubtitleOverlayAppearance['shadow']): string {
  if (value === 'none') return 'none';
  if (value === 'strong') {
    return '0 2px 5px rgb(0 0 0 / 1), 0 0 2px rgb(0 0 0 / 1)';
  }
  return '0 1px 2px rgb(0 0 0 / 0.9)';
}

function fontFamilyValue(
  value: SubtitleLanguageAppearance['fontFamily'],
): string {
  switch (value) {
    case 'mono':
      return 'ui-monospace, "Cascadia Mono", monospace';
    case 'rounded':
      return 'ui-rounded, "Arial Rounded MT Bold", "Microsoft YaHei", sans-serif';
    case 'serif':
      return 'Georgia, "Noto Serif CJK SC", "Songti SC", serif';
    case 'system':
      return 'system-ui, -apple-system, "Segoe UI", sans-serif';
    case 'sans':
      return '"Noto Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif';
  }
}

function resolveDocument(
  injected: SubtitleOverlayDocument | undefined,
): SubtitleOverlayDocument {
  if (injected !== undefined) return injected;
  if (typeof document === 'undefined') {
    throw new Error('A document is required to mount the subtitle overlay.');
  }
  return document as unknown as SubtitleOverlayDocument;
}

function createBrowserRenderRoot(
  container: SubtitleOverlayNode,
): SubtitleOverlayRenderRoot {
  const reactRoot = createRoot(container as unknown as Element);
  let revision = 0;
  let failed = false;
  return {
    render(node, lifecycle) {
      if (failed) {
        revision += 1;
        failed = false;
      }
      reactRoot.render(
        <OverlayErrorBoundary
          key={revision}
          onError={() => {
            failed = true;
            lifecycle.onError();
          }}
        >
          <OverlayCommitSignal onCommit={lifecycle.onCommit}>
            {node}
          </OverlayCommitSignal>
        </OverlayErrorBoundary>,
      );
    },
    clear() {
      revision += 1;
      reactRoot.render(null);
    },
    unmount() {
      reactRoot.unmount();
    },
  };
}

function OverlayCommitSignal(props: {
  readonly children: ReactNode;
  readonly onCommit: () => void;
}): ReactNode {
  useLayoutEffect(() => {
    props.onCommit();
  }, [props.onCommit]);
  return props.children;
}

class OverlayErrorBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly onError: () => void;
  },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    this.props.onError();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
