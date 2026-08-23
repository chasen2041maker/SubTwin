import { describe, expect, it } from 'vitest';

import { createMessage } from '../../src/shared/messages';
import { parseDeepSeekTestActionResponse } from '../../src/storage/action-client';

const requestId = 'options-request-1';

function validResponse() {
  return {
    ok: true,
    value: createMessage({
      id: `${requestId}:background`,
      source: 'background',
      type: 'settings/deepseek-test-result',
      payload: { status: 'success', errorCode: null, retryable: false },
    }),
  };
}

describe('settings action client response parsing', () => {
  it('accepts only the expected exact background envelope and request id', () => {
    expect(parseDeepSeekTestActionResponse(validResponse(), requestId)).toMatchObject({
      source: 'background',
      type: 'settings/deepseek-test-result',
      payload: { status: 'success' },
    });
    expect(parseDeepSeekTestActionResponse(validResponse(), 'another-request')).toBeNull();
  });

  it('rejects outer extras, envelope extras, wrong types, and leaked fields', () => {
    expect(parseDeepSeekTestActionResponse(
      { ...validResponse(), diagnostic: 'secret' },
      requestId,
    )).toBeNull();
    expect(parseDeepSeekTestActionResponse({
      ok: true,
      value: { ...validResponse().value, apiKey: 'secret' },
    }, requestId)).toBeNull();
    expect(parseDeepSeekTestActionResponse({
      ok: true,
      value: {
        ...validResponse().value,
        payload: { ...validResponse().value.payload, apiKey: 'secret' },
      },
    }, requestId)).toBeNull();
  });
});
