import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeXhr {
  open(): void {}
  send(): void {}
}

class FakeWindow {
  readonly location = { origin: 'https://www.netflix.com' };
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    url: '',
    headers: new Headers(),
    body: null,
    clone() {
      return this;
    },
    text: async () => '',
  }));
  XMLHttpRequest = FakeXhr as never;

  addEventListener(
    type: string,
    listener: (event: Event) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: (event: Event) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(): void {}

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type } as Event);
    }
  }
}

interface EntrypointDefinition {
  readonly main: () => void;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Netflix MAIN-world entrypoint lifecycle', () => {
  it('reuses the global version sentinel across bundle reloads and disposes on page teardown', async () => {
    vi.useFakeTimers();
    const window = new FakeWindow();
    const definitions: EntrypointDefinition[] = [];
    vi.stubGlobal('window', window);
    vi.stubGlobal('defineContentScript', (value: EntrypointDefinition) => {
      definitions.push(value);
      return value;
    });

    await import('../../entrypoints/netflix-main-world.content');
    const firstDefinition = definitions[0];
    if (firstDefinition === undefined) throw new Error('entrypoint was not defined');
    firstDefinition.main();
    expect(window.listenerCount('message')).toBe(1);

    vi.resetModules();
    await import('../../entrypoints/netflix-main-world.content');
    const secondDefinition = definitions[1];
    if (secondDefinition === undefined) throw new Error('entrypoint was not defined');
    secondDefinition.main();
    expect(window.listenerCount('message')).toBe(1);
    expect(window.listenerCount('pagehide')).toBe(1);

    window.emit('pagehide');
    expect(window.listenerCount('message')).toBe(0);
  });
});
