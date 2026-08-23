import { err, ok, type AppError, type Result } from '../shared/result';
import {
  NETFLIX_BRIDGE_PROTOCOL,
  NETFLIX_BRIDGE_VERSION,
  NETFLIX_PAGE_ORIGIN,
  createEarlyBridgeQueue,
  parseNetflixBridgeEvent,
  type NetflixBridgePayload,
  type NetflixWindowMessageEvent,
} from './bridge';
import {
  installFetchProbe,
  installXhrProbe,
  type FetchTargetLike,
  type NetworkProbeOptions,
  type ProbeInstallation,
  type XhrConstructorLike,
} from './probe';

export const NETFLIX_CONTROL_SOURCE =
  'subtwin-netflix-isolated-world' as const;

export type NetflixControlType = 'connect' | 'disconnect';

export interface NetflixControlEnvelope {
  readonly protocol: typeof NETFLIX_BRIDGE_PROTOCOL;
  readonly version: typeof NETFLIX_BRIDGE_VERSION;
  readonly source: typeof NETFLIX_CONTROL_SOURCE;
  readonly type: NetflixControlType;
  readonly nonce: string;
  readonly generation: number;
}

export type NetflixRuntimeError = AppError<
  'invalid_netflix_control' | 'netflix_runtime_unavailable'
>;

export interface NetflixRuntimeWindow {
  readonly location: { readonly origin: string };
  fetch: FetchTargetLike['fetch'];
  readonly XMLHttpRequest: XhrConstructorLike;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(data: unknown, targetOrigin: string): void;
}

export interface IsolatedNetflixBridge {
  start(): Result<undefined, NetflixRuntimeError>;
  dispose(): void;
}

export function parseNetflixControlEvent(
  event: NetflixWindowMessageEvent,
  expectedWindow: NetflixRuntimeWindow,
): Result<NetflixControlEnvelope, NetflixRuntimeError> {
  if (
    event.origin !== NETFLIX_PAGE_ORIGIN ||
    expectedWindow.location.origin !== NETFLIX_PAGE_ORIGIN ||
    event.source !== expectedWindow ||
    !isRecord(event.data) ||
    !hasExactlyKeys(event.data, [
      'generation',
      'nonce',
      'protocol',
      'source',
      'type',
      'version',
    ]) ||
    event.data.protocol !== NETFLIX_BRIDGE_PROTOCOL ||
    event.data.version !== NETFLIX_BRIDGE_VERSION ||
    event.data.source !== NETFLIX_CONTROL_SOURCE ||
    (event.data.type !== 'connect' && event.data.type !== 'disconnect') ||
    !isNonce(event.data.nonce) ||
    !isGeneration(event.data.generation)
  ) {
    return runtimeError('invalid_netflix_control');
  }

  return ok(event.data as unknown as NetflixControlEnvelope);
}

export function createIsolatedNetflixBridge(options: {
  readonly window: NetflixRuntimeWindow;
  readonly nonce: string;
  readonly generation: number;
  readonly onPayload: (payload: NetflixBridgePayload) => void;
}): IsolatedNetflixBridge {
  let started = false;
  let disposed = false;

  const onMessage = (event: MessageEvent): void => {
    if (!started || disposed) return;
    const parsed = parseNetflixBridgeEvent(event, {
      nonce: options.nonce,
      generation: options.generation,
      source: options.window,
    });
    if (!parsed.ok) return;
    try {
      options.onPayload(parsed.value.payload);
    } catch {
      // An isolated consumer must not feed exceptions back into Netflix's page.
    }
  };

  return {
    start() {
      if (started || disposed) return ok(undefined);
      if (
        options.window.location.origin !== NETFLIX_PAGE_ORIGIN ||
        !isNonce(options.nonce) ||
        !isGeneration(options.generation)
      ) {
        return runtimeError('netflix_runtime_unavailable');
      }

      started = true;
      options.window.addEventListener('message', onMessage);
      postControl(options.window, {
        type: 'connect',
        nonce: options.nonce,
        generation: options.generation,
      });
      return ok(undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!started) return;
      options.window.removeEventListener('message', onMessage);
      postControl(options.window, {
        type: 'disconnect',
        nonce: options.nonce,
        generation: options.generation,
      });
    },
  };
}

export interface MainWorldNetflixRuntime extends ProbeInstallation {}

type FetchInstaller = (
  target: FetchTargetLike,
  options: NetworkProbeOptions,
) => ProbeInstallation;
type XhrInstaller = (
  target: XhrConstructorLike,
  options: NetworkProbeOptions,
) => ProbeInstallation;

interface ActiveProbeSession {
  readonly nonce: string;
  readonly generation: number;
  readonly fetch: ProbeInstallation;
  readonly xhr: ProbeInstallation;
  readonly disposeQueue: () => void;
  readonly queue: ReturnType<typeof createEarlyBridgeQueue>;
}

const MAIN_RUNTIMES = new WeakMap<object, MainWorldNetflixRuntime>();

export function installMainWorldNetflixRuntime(options: {
  readonly window: NetflixRuntimeWindow;
  readonly installFetch?: FetchInstaller;
  readonly installXhr?: XhrInstaller;
}): MainWorldNetflixRuntime {
  const existing = MAIN_RUNTIMES.get(options.window);
  if (existing !== undefined) return existing;

  const installFetch = options.installFetch ?? installFetchProbe;
  const installXhr = options.installXhr ?? installXhrProbe;
  let disposed = false;
  let active: ActiveProbeSession | undefined;
  let highestGeneration = -1;

  const disposeActive = (): void => {
    const current = active;
    active = undefined;
    if (current === undefined) return;
    current.fetch.dispose();
    current.xhr.dispose();
    current.disposeQueue();
    current.queue.dispose();
  };

  const connect = (control: NetflixControlEnvelope): void => {
    if (disposed) return;
    if (
      active?.generation === control.generation &&
      active.nonce === control.nonce
    ) {
      return;
    }
    if (control.generation <= highestGeneration) return;

    disposeActive();
    const previousHighestGeneration = highestGeneration;
    highestGeneration = control.generation;
    const queue = createEarlyBridgeQueue({
      nonce: control.nonce,
      generation: control.generation,
    });
    const disposeQueue = queue.attach((message) => {
      safePost(options.window, message);
    });
    const probeOptions: NetworkProbeOptions = {
      generation: control.generation,
      currentGeneration: () => active?.generation ?? highestGeneration,
      onTimedText: (payload) => {
        queue.publish(payload, control.generation);
      },
      onCatalog: (payload) => {
        queue.publish(payload, control.generation);
      },
    };

    let fetch: ProbeInstallation | undefined;
    let xhr: ProbeInstallation | undefined;
    try {
      fetch = installFetch(options.window, probeOptions);
      xhr = installXhr(options.window.XMLHttpRequest, probeOptions);
      active = {
        nonce: control.nonce,
        generation: control.generation,
        fetch,
        xhr,
        disposeQueue,
        queue,
      };
    } catch {
      fetch?.dispose();
      xhr?.dispose();
      disposeQueue();
      queue.dispose();
      highestGeneration = previousHighestGeneration;
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    const parsed = parseNetflixControlEvent(event, options.window);
    if (!parsed.ok) return;
    if (parsed.value.type === 'connect') {
      connect(parsed.value);
      return;
    }
    if (
      active?.nonce === parsed.value.nonce &&
      active.generation === parsed.value.generation
    ) {
      disposeActive();
    }
  };

  const runtime: MainWorldNetflixRuntime = {
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeActive();
      options.window.removeEventListener('message', onMessage);
      if (MAIN_RUNTIMES.get(options.window) === runtime) {
        MAIN_RUNTIMES.delete(options.window);
      }
    },
  };

  options.window.addEventListener('message', onMessage);
  MAIN_RUNTIMES.set(options.window, runtime);
  return runtime;
}

function postControl(
  target: NetflixRuntimeWindow,
  input: {
    readonly type: NetflixControlType;
    readonly nonce: string;
    readonly generation: number;
  },
): void {
  safePost(target, {
    protocol: NETFLIX_BRIDGE_PROTOCOL,
    version: NETFLIX_BRIDGE_VERSION,
    source: NETFLIX_CONTROL_SOURCE,
    type: input.type,
    nonce: input.nonce,
    generation: input.generation,
  });
}

function safePost(target: NetflixRuntimeWindow, data: unknown): void {
  try {
    target.postMessage(data, NETFLIX_PAGE_ORIGIN);
  } catch {
    // Bridge failure must leave the page's native behavior untouched.
  }
}

function isNonce(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function runtimeError(
  code: NetflixRuntimeError['code'],
): Result<never, NetflixRuntimeError> {
  return err({
    code,
    message: 'The Netflix probe runtime rejected an invalid request.',
    retryable: false,
  });
}
