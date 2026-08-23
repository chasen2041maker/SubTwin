import type { NativeSubtitleVisibility } from '../renderer/SubtitleOverlay';

const NATIVE_SUBTITLE_SELECTORS = [
  '.player-timedtext-text-container',
  '[data-uia="player-subtitle"]',
  '.player-timedtext',
] as const;

export interface NativeSubtitleVisibilityStyle {
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
  setProperty(name: string, value: string, priority?: string): void;
  removeProperty(name: string): string;
}

export interface NativeSubtitleVisibilityElement {
  readonly style: NativeSubtitleVisibilityStyle;
}

export interface NativeSubtitleVisibilityDocument {
  readonly root: unknown;
  querySelectorAll(selector: string): Iterable<NativeSubtitleVisibilityElement>;
}

export interface NativeSubtitleVisibilityObserver {
  observe(
    target: unknown,
    options: { readonly childList: boolean; readonly subtree: boolean },
  ): void;
  disconnect(): void;
}

export interface CreateNativeSubtitleVisibilityOptions {
  readonly document: NativeSubtitleVisibilityDocument;
  readonly createObserver: (
    callback: () => void,
  ) => NativeSubtitleVisibilityObserver;
}

interface OriginalVisibility {
  readonly value: string;
  readonly priority: string;
}

export function createNativeSubtitleVisibility(
  options: CreateNativeSubtitleVisibilityOptions,
): NativeSubtitleVisibility {
  const touched = new Map<NativeSubtitleVisibilityElement, OriginalVisibility>();
  let observer: NativeSubtitleVisibilityObserver | undefined;
  let hidden = false;

  const restore = (): void => {
    if (!hidden && touched.size === 0 && observer === undefined) return;
    hidden = false;
    observer?.disconnect();
    observer = undefined;
    for (const [node, original] of touched) {
      try {
        if (original.value === '') node.style.removeProperty('visibility');
        else node.style.setProperty('visibility', original.value, original.priority);
      } catch {
        // A detached Netflix node cannot affect the currently visible player.
      }
    }
    touched.clear();
  };

  const hideCurrentContainers = (): void => {
    const matches = new Set<NativeSubtitleVisibilityElement>();
    for (const selector of NATIVE_SUBTITLE_SELECTORS) {
      for (const node of options.document.querySelectorAll(selector)) {
        matches.add(node);
      }
    }
    for (const node of matches) {
      if (!touched.has(node)) {
        touched.set(node, {
          value: node.style.getPropertyValue('visibility'),
          priority: node.style.getPropertyPriority('visibility'),
        });
      }
      node.style.setProperty('visibility', 'hidden', 'important');
    }
  };

  return {
    hide() {
      if (hidden) return;
      hidden = true;
      try {
        hideCurrentContainers();
        observer = options.createObserver(() => {
          if (!hidden) return;
          try {
            hideCurrentContainers();
          } catch {
            restore();
          }
        });
        observer.observe(options.document.root, {
          childList: true,
          subtree: true,
        });
      } catch (error) {
        restore();
        throw error;
      }
    },
    restore,
  };
}
