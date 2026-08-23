export type JsonPrimitive = boolean | number | string | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export interface AppError<Code extends string> {
  readonly code: Code;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface Success<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Failure<E extends AppError<string>> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E extends AppError<string>> = Success<T> | Failure<E>;

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends AppError<string>>(error: E): Result<never, E> {
  return { ok: false, error };
}
