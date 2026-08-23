import { err, ok, type AppError, type Result } from './result';

export const MESSAGE_PROTOCOL = 'subtwin' as const;
export const MESSAGE_PROTOCOL_VERSION = 1 as const;

export type ExtensionContext =
  | 'background'
  | 'content'
  | 'options'
  | 'page'
  | 'popup';

export interface MessagePayloadMap {
  readonly 'system/health-check': {
    readonly sentAt: number;
  };
  readonly 'system/health-response': {
    readonly requestId: string;
    readonly ready: true;
  };
}

export type MessageType = keyof MessagePayloadMap;

export interface MessageEnvelope<Type extends MessageType> {
  readonly protocol: typeof MESSAGE_PROTOCOL;
  readonly version: typeof MESSAGE_PROTOCOL_VERSION;
  readonly id: string;
  readonly source: ExtensionContext;
  readonly type: Type;
  readonly payload: MessagePayloadMap[Type];
}

export type MessageFor<Type extends MessageType> = MessageEnvelope<Type>;

export type ExtensionMessage = {
  readonly [Type in MessageType]: MessageFor<Type>;
}[MessageType];

export type MessageValidationError = AppError<
  'invalid_message' | 'unsupported_message_version'
>;

export type MessageDraft<Type extends MessageType> = Omit<
  MessageFor<Type>,
  'protocol' | 'version'
>;

export function createMessage<Type extends MessageType>(
  draft: MessageDraft<Type>,
): MessageFor<Type> {
  return {
    protocol: MESSAGE_PROTOCOL,
    version: MESSAGE_PROTOCOL_VERSION,
    id: draft.id,
    source: draft.source,
    type: draft.type,
    payload: draft.payload,
  };
}

export function parseMessageEnvelope(
  input: unknown,
): Result<ExtensionMessage, MessageValidationError> {
  if (!isRecord(input) || input.protocol !== MESSAGE_PROTOCOL) {
    return invalidMessage();
  }

  if (
    typeof input.version === 'number' &&
    input.version !== MESSAGE_PROTOCOL_VERSION
  ) {
    return err({
      code: 'unsupported_message_version',
      message: 'Unsupported SubTwin message protocol version.',
      retryable: false,
      details: {
        receivedVersion: input.version,
        supportedVersion: MESSAGE_PROTOCOL_VERSION,
      },
    });
  }

  if (
    input.version !== MESSAGE_PROTOCOL_VERSION ||
    !isNonEmptyString(input.id) ||
    !isExtensionContext(input.source)
  ) {
    return invalidMessage();
  }

  if (
    input.type === 'system/health-check' &&
    isHealthCheckPayload(input.payload)
  ) {
    return ok(
      createMessage({
        id: input.id,
        source: input.source,
        type: input.type,
        payload: input.payload,
      }),
    );
  }

  if (
    input.type === 'system/health-response' &&
    isHealthResponsePayload(input.payload)
  ) {
    return ok(
      createMessage({
        id: input.id,
        source: input.source,
        type: input.type,
        payload: input.payload,
      }),
    );
  }

  return invalidMessage();
}

const EXTENSION_CONTEXTS: readonly ExtensionContext[] = [
  'background',
  'content',
  'options',
  'page',
  'popup',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isExtensionContext(value: unknown): value is ExtensionContext {
  return EXTENSION_CONTEXTS.some((context) => context === value);
}

function isHealthCheckPayload(
  value: unknown,
): value is MessagePayloadMap['system/health-check'] {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['sentAt']) &&
    typeof value.sentAt === 'number' &&
    Number.isFinite(value.sentAt) &&
    value.sentAt >= 0
  );
}

function isHealthResponsePayload(
  value: unknown,
): value is MessagePayloadMap['system/health-response'] {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['ready', 'requestId']) &&
    value.ready === true &&
    isNonEmptyString(value.requestId)
  );
}

function hasExactlyKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);

  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
}

function invalidMessage(): Result<never, MessageValidationError> {
  return err({
    code: 'invalid_message',
    message: 'Invalid SubTwin message envelope.',
    retryable: false,
  });
}
