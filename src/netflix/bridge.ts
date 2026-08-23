import { err, ok, type AppError, type Result } from '../shared/result';

export const NETFLIX_BRIDGE_PROTOCOL = 'subtwin.netflix.bridge' as const;
export const NETFLIX_BRIDGE_VERSION = 1 as const;
export const NETFLIX_BRIDGE_SOURCE = 'subtwin-netflix-main-world' as const;
export const NETFLIX_PAGE_ORIGIN = 'https://www.netflix.com' as const;
export const MAX_NETFLIX_BRIDGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_EARLY_BRIDGE_CAPACITY = 32;

export type NetflixTrackKind = 'closed-caption' | 'subtitle';

export interface NetflixCatalogTrackDescriptor {
  readonly id: string;
  readonly language: string;
  readonly kind: NetflixTrackKind;
}

export interface NetflixCatalogPayload {
  readonly type: 'catalog';
  readonly titleId: string;
  readonly authority: 'authoritative' | 'provisional';
  readonly tracks: readonly NetflixCatalogTrackDescriptor[];
}

export interface NetflixTimedTextPayload {
  readonly type: 'timed-text';
  readonly titleId: string;
  readonly resourceId: string;
  readonly trackId: string;
  readonly language: string;
  readonly format: 'ttml' | 'webvtt';
  readonly body: string;
}

export type NetflixDiagnosticCode =
  | 'candidate_rejected'
  | 'display_unavailable'
  | 'probe_disposed'
  | 'unsupported_payload';

export interface NetflixDiagnosticPayload {
  readonly type: 'diagnostic';
  readonly code: NetflixDiagnosticCode;
}

export type NetflixBridgePayload =
  | NetflixCatalogPayload
  | NetflixDiagnosticPayload
  | NetflixTimedTextPayload;

export interface NetflixBridgeEnvelope {
  readonly protocol: typeof NETFLIX_BRIDGE_PROTOCOL;
  readonly version: typeof NETFLIX_BRIDGE_VERSION;
  readonly source: typeof NETFLIX_BRIDGE_SOURCE;
  readonly nonce: string;
  readonly generation: number;
  readonly payload: NetflixBridgePayload;
}

export type NetflixBridgeError = AppError<
  | 'bridge_origin_mismatch'
  | 'bridge_payload_too_large'
  | 'bridge_source_mismatch'
  | 'invalid_bridge_message'
  | 'stale_bridge_generation'
  | 'unsupported_bridge_version'
  | 'wrong_bridge_session'
>;

export interface NetflixWindowMessageEvent {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

interface BridgeLimits {
  readonly maxEnvelopeBytes?: number;
  readonly maxTimedTextBytes?: number;
}

export function createNetflixBridgeEnvelope(
  input: {
    readonly nonce: string;
    readonly generation: number;
    readonly payload: unknown;
  },
  limits: BridgeLimits = {},
): Result<NetflixBridgeEnvelope, NetflixBridgeError> {
  if (!isNonce(input.nonce) || !isGeneration(input.generation)) {
    return bridgeError('invalid_bridge_message');
  }

  const payload = parsePayload(
    input.payload,
    limits.maxTimedTextBytes ?? MAX_NETFLIX_BRIDGE_BYTES,
  );
  if (!payload.ok) return payload;

  const envelope: NetflixBridgeEnvelope = {
    protocol: NETFLIX_BRIDGE_PROTOCOL,
    version: NETFLIX_BRIDGE_VERSION,
    source: NETFLIX_BRIDGE_SOURCE,
    nonce: input.nonce,
    generation: input.generation,
    payload: payload.value,
  };

  if (
    serializedBytes(envelope) >
    (limits.maxEnvelopeBytes ?? MAX_NETFLIX_BRIDGE_BYTES)
  ) {
    return bridgeError('bridge_payload_too_large');
  }

  return ok(envelope);
}

export function parseNetflixBridgeEvent(
  event: NetflixWindowMessageEvent,
  expected: {
    readonly nonce: string;
    readonly generation: number;
    readonly source: unknown;
  },
  limits: BridgeLimits = {},
): Result<NetflixBridgeEnvelope, NetflixBridgeError> {
  if (event.origin !== NETFLIX_PAGE_ORIGIN) {
    return bridgeError('bridge_origin_mismatch');
  }
  if (event.source !== expected.source) {
    return bridgeError('bridge_source_mismatch');
  }
  if (
    serializedBytes(event.data) >
    (limits.maxEnvelopeBytes ?? MAX_NETFLIX_BRIDGE_BYTES)
  ) {
    return bridgeError('bridge_payload_too_large');
  }
  if (!isRecord(event.data) || !hasExactlyKeys(event.data, [
    'generation',
    'nonce',
    'payload',
    'protocol',
    'source',
    'version',
  ])) {
    return bridgeError('invalid_bridge_message');
  }
  if (event.data.protocol !== NETFLIX_BRIDGE_PROTOCOL) {
    return bridgeError('invalid_bridge_message');
  }
  if (event.data.version !== NETFLIX_BRIDGE_VERSION) {
    return bridgeError('unsupported_bridge_version');
  }
  if (event.data.source !== NETFLIX_BRIDGE_SOURCE) {
    return bridgeError('invalid_bridge_message');
  }
  if (event.data.nonce !== expected.nonce) {
    return bridgeError('wrong_bridge_session');
  }
  if (event.data.generation !== expected.generation) {
    return bridgeError('stale_bridge_generation');
  }

  return createNetflixBridgeEnvelope(
    {
      nonce: event.data.nonce,
      generation: event.data.generation,
      payload: event.data.payload,
    },
    limits,
  );
}

export interface EarlyBridgeQueue {
  readonly size: number;
  publish(payload: unknown, generation?: number): boolean;
  attach(listener: (message: NetflixBridgeEnvelope) => void): () => void;
  nextGeneration(generation: number, nonce: string): void;
  dispose(): void;
}

export function createEarlyBridgeQueue(options: {
  readonly nonce: string;
  readonly generation: number;
  readonly capacity?: number;
}): EarlyBridgeQueue {
  let nonce = options.nonce;
  let generation = options.generation;
  let disposed = false;
  let listener: ((message: NetflixBridgeEnvelope) => void) | undefined;
  const pending: NetflixBridgeEnvelope[] = [];
  const capacity =
    Number.isInteger(options.capacity) && (options.capacity ?? 0) > 0
      ? Math.min(options.capacity ?? DEFAULT_EARLY_BRIDGE_CAPACITY, 256)
      : DEFAULT_EARLY_BRIDGE_CAPACITY;

  return {
    get size() {
      return pending.length;
    },
    publish(payload, observedGeneration = generation) {
      if (disposed || observedGeneration !== generation) return false;
      const message = createNetflixBridgeEnvelope({
        nonce,
        generation,
        payload,
      });
      if (!message.ok) return false;

      if (listener !== undefined) {
        listener(message.value);
      } else {
        if (pending.length === capacity) pending.shift();
        pending.push(message.value);
      }
      return true;
    },
    attach(nextListener) {
      if (disposed) return () => undefined;
      listener = nextListener;
      const buffered = pending.splice(0);
      for (const message of buffered) nextListener(message);
      return () => {
        if (listener === nextListener) listener = undefined;
      };
    },
    nextGeneration(nextGeneration, nextNonce) {
      if (
        disposed ||
        !isGeneration(nextGeneration) ||
        !isNonce(nextNonce) ||
        nextGeneration <= generation
      ) {
        return;
      }
      generation = nextGeneration;
      nonce = nextNonce;
      pending.splice(0);
    },
    dispose() {
      disposed = true;
      listener = undefined;
      pending.splice(0);
    },
  };
}

function parsePayload(
  value: unknown,
  maxTimedTextBytes: number,
): Result<NetflixBridgePayload, NetflixBridgeError> {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return bridgeError('invalid_bridge_message');
  }

  if (
    value.type === 'timed-text' &&
    hasExactlyKeys(value, [
      'body',
      'format',
      'language',
      'resourceId',
      'titleId',
      'trackId',
      'type',
    ]) &&
    isOpaqueId(value.titleId) &&
    isOpaqueResourceId(value.resourceId) &&
    isOpaqueId(value.trackId) &&
    isLanguage(value.language) &&
    (value.format === 'ttml' || value.format === 'webvtt') &&
    typeof value.body === 'string'
  ) {
    if (utf8Bytes(value.body) > maxTimedTextBytes) {
      return bridgeError('bridge_payload_too_large');
    }
    return ok({
      type: 'timed-text',
      titleId: value.titleId,
      resourceId: value.resourceId,
      trackId: value.trackId,
      language: value.language,
      format: value.format,
      body: value.body,
    });
  }

  if (
    value.type === 'diagnostic' &&
    hasExactlyKeys(value, ['code', 'type']) &&
    isDiagnosticCode(value.code)
  ) {
    return ok({ type: 'diagnostic', code: value.code });
  }

  if (
    value.type === 'catalog' &&
    hasExactlyKeys(value, ['authority', 'titleId', 'tracks', 'type']) &&
    isOpaqueId(value.titleId) &&
    (value.authority === 'authoritative' || value.authority === 'provisional') &&
    Array.isArray(value.tracks) &&
    value.tracks.length <= 256 &&
    value.tracks.every(isCatalogTrack)
  ) {
    return ok({
      type: 'catalog',
      titleId: value.titleId,
      authority: value.authority,
      tracks: (value.tracks as NetflixCatalogTrackDescriptor[]).map(
        ({ id, language, kind }) => ({ id, language, kind }),
      ),
    });
  }

  return bridgeError('invalid_bridge_message');
}

function isCatalogTrack(value: unknown): value is NetflixCatalogTrackDescriptor {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['id', 'kind', 'language']) &&
    isOpaqueId(value.id) &&
    isLanguage(value.language) &&
    (value.kind === 'subtitle' || value.kind === 'closed-caption')
  );
}

function isDiagnosticCode(value: unknown): value is NetflixDiagnosticCode {
  return (
    value === 'candidate_rejected' ||
    value === 'display_unavailable' ||
    value === 'probe_disposed' ||
    value === 'unsupported_payload'
  );
}

function isLanguage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 35 &&
    /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)
  );
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function isOpaqueResourceId(value: unknown): value is string {
  return typeof value === 'string' && /^tt_[a-f0-9]{16}$/.test(value);
}

function isNonce(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
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

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : utf8Bytes(serialized);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function bridgeError(code: NetflixBridgeError['code']): Result<never, NetflixBridgeError> {
  return err({
    code,
    message: 'Rejected an invalid Netflix page bridge message.',
    retryable: false,
  });
}
