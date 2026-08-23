import { describe, expect, it, vi } from 'vitest';

import {
  createNativeSubtitleVisibility,
  type NativeSubtitleVisibilityDocument,
  type NativeSubtitleVisibilityElement,
  type NativeSubtitleVisibilityObserver,
} from '../../src/netflix/native-subtitle-visibility';

class FakeStyle {
  value = '';
  priority = '';

  getPropertyValue(name: string): string {
    return name === 'visibility' ? this.value : '';
  }

  getPropertyPriority(name: string): string {
    return name === 'visibility' ? this.priority : '';
  }

  setProperty(name: string, value: string, priority = ''): void {
    if (name !== 'visibility') return;
    this.value = value;
    this.priority = priority;
  }

  removeProperty(name: string): string {
    if (name !== 'visibility') return '';
    const previous = this.value;
    this.value = '';
    this.priority = '';
    return previous;
  }
}

function element(visibility = '', priority = ''): NativeSubtitleVisibilityElement & {
  readonly style: FakeStyle;
} {
  const style = new FakeStyle();
  style.value = visibility;
  style.priority = priority;
  return { style };
}

function harness(initial: readonly NativeSubtitleVisibilityElement[]) {
  let nodes = [...initial];
  let notify: () => void = () => undefined;
  const disconnect = vi.fn();
  const observer: NativeSubtitleVisibilityObserver = {
    observe: vi.fn(),
    disconnect,
  };
  const document: NativeSubtitleVisibilityDocument = {
    root: {},
    querySelectorAll: vi.fn(() => nodes),
  };
  const visibility = createNativeSubtitleVisibility({
    document,
    createObserver(callback) {
      notify = callback;
      return observer;
    },
  });
  return {
    disconnect,
    document,
    notify: () => notify(),
    replaceNodes: (next: readonly NativeSubtitleVisibilityElement[]) => {
      nodes = [...next];
    },
    visibility,
  };
}

describe('Netflix native subtitle visibility', () => {
  it('hides every current container and restores each original inline value', () => {
    const first = element();
    const second = element('collapse', 'important');
    const { visibility } = harness([first, second]);

    visibility.hide();

    expect(first.style).toMatchObject({ value: 'hidden', priority: 'important' });
    expect(second.style).toMatchObject({ value: 'hidden', priority: 'important' });

    visibility.restore();

    expect(first.style).toMatchObject({ value: '', priority: '' });
    expect(second.style).toMatchObject({ value: 'collapse', priority: 'important' });
  });

  it('hides replacement containers while active and restores all touched nodes', () => {
    const first = element('visible');
    const next = element();
    const runtime = harness([first]);

    runtime.visibility.hide();
    runtime.replaceNodes([next]);
    runtime.notify();

    expect(next.style.value).toBe('hidden');
    runtime.visibility.restore();
    expect(first.style.value).toBe('visible');
    expect(next.style.value).toBe('');
    expect(runtime.disconnect).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across repeated hide and restore calls', () => {
    const node = element('visible');
    const runtime = harness([node]);

    runtime.visibility.hide();
    runtime.visibility.hide();
    runtime.visibility.restore();
    runtime.visibility.restore();

    expect(node.style.value).toBe('visible');
    expect(runtime.disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails safe by restoring native subtitles if a remount scan throws', () => {
    const node = element('visible');
    const runtime = harness([node]);

    runtime.visibility.hide();
    vi.mocked(runtime.document.querySelectorAll).mockImplementation(() => {
      throw new Error('detached document');
    });
    expect(() => runtime.notify()).not.toThrow();

    expect(node.style.value).toBe('visible');
    expect(runtime.disconnect).toHaveBeenCalledTimes(1);
  });
});
