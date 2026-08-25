import {
  installMainWorldNetflixRuntime,
  type MainWorldNetflixRuntime,
  type NetflixRuntimeWindow,
} from '../src/netflix/runtime';

const MAIN_ENTRY_SENTINEL = Symbol.for(
  'subtwin.netflix.main-world-entry.v1',
);

interface MainEntrySentinel {
  readonly runtime: MainWorldNetflixRuntime;
  readonly onPageHide: () => void;
}

export default defineContentScript({
  matches: ['https://www.netflix.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  noScriptStartedPostMessage: true,
  main() {
    const runtime = installMainWorldNetflixRuntime({
      window: window as unknown as NetflixRuntimeWindow,
      onDownloadDiagnostic: (code) => {
        console.warn('[SubTwin] Netflix timed-text download failed:', code);
      },
      onDownloadEvent: (event) => {
        console.info(
          '[SubTwin] Netflix timed-text download:',
          event.state,
          event.language,
          event.code ?? '',
        );
      },
      onCatalogMatchDiagnostic: (diagnostic) => {
        console.info(
          '[SubTwin] Netflix catalog match:',
          JSON.stringify(diagnostic),
        );
      },
      onTrackCaptureEvent: (event) => {
        console.info(
          '[SubTwin] Netflix controlled track capture:',
          event.state,
          event.language,
        );
      },
      onTimedTextCandidate: (event) => {
        console.info(
          '[SubTwin] Netflix timed-text candidate:',
          event.transport,
          event.responseType,
          event.bound ? 'bound' : 'unbound',
          event.stage,
          event.outcome,
        );
      },
      onTimedTextObservation: (event) => {
        console.info(
          '[SubTwin] Netflix timed-text body:',
          event.format,
          event.language,
        );
      },
      onPerformanceTimedTextEvent: (event) => {
        console.info(
          '[SubTwin] Netflix performance timed-text:',
          JSON.stringify(event),
        );
      },
    });
    const previous = readEntrySentinel(window);
    if (previous?.runtime === runtime) return;
    if (previous !== undefined) {
      window.removeEventListener('pagehide', previous.onPageHide);
      previous.runtime.dispose();
    }
    const onPageHide = (): void => {
      runtime.dispose();
      clearEntrySentinel(window, runtime);
    };
    window.addEventListener('pagehide', onPageHide, { once: true });
    writeEntrySentinel(window, { runtime, onPageHide });
  },
});

function readEntrySentinel(target: object): MainEntrySentinel | undefined {
  try {
    const value = Reflect.get(target, MAIN_ENTRY_SENTINEL) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof Reflect.get(value, 'onPageHide') !== 'function'
    ) return undefined;
    const runtime = Reflect.get(value, 'runtime') as unknown;
    return typeof runtime === 'object' &&
      runtime !== null &&
      typeof Reflect.get(runtime, 'dispose') === 'function'
      ? value as MainEntrySentinel
      : undefined;
  } catch {
    return undefined;
  }
}

function writeEntrySentinel(
  target: object,
  sentinel: MainEntrySentinel,
): void {
  try {
    Object.defineProperty(target, MAIN_ENTRY_SENTINEL, {
      configurable: true,
      enumerable: false,
      value: Object.freeze(sentinel),
      writable: false,
    });
  } catch {
    // The runtime-level sentinel still prevents duplicate probes.
  }
}

function clearEntrySentinel(
  target: object,
  runtime: MainWorldNetflixRuntime,
): void {
  try {
    if (readEntrySentinel(target)?.runtime === runtime) {
      Reflect.deleteProperty(target, MAIN_ENTRY_SENTINEL);
    }
  } catch {
    // Page teardown cleanup is best-effort.
  }
}
