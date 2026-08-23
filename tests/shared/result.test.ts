import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  err,
  ok,
  type AppError,
  type Result,
} from '../../src/shared/result';

type InvalidInputError = AppError<'invalid_input'>;

describe('Result', () => {
  it('creates a success result that narrows to its value', () => {
    const result: Result<{ readonly cueId: string }, InvalidInputError> = ok({
      cueId: 'cue-1',
    });

    expect(result).toEqual({ ok: true, value: { cueId: 'cue-1' } });

    if (result.ok) {
      expectTypeOf(result.value.cueId).toEqualTypeOf<string>();
    }
  });

  it('creates a failure result that narrows to its typed error', () => {
    const failure: InvalidInputError = {
      code: 'invalid_input',
      message: 'The input is invalid.',
      retryable: false,
      details: { field: 'cueId', received: null },
    };
    const result: Result<number, InvalidInputError> = err(failure);

    expect(result).toEqual({ ok: false, error: failure });

    if (!result.ok) {
      expectTypeOf(result.error.code).toEqualTypeOf<'invalid_input'>();
    }
  });
});
