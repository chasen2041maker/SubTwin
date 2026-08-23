import { describe, expect, it } from 'vitest';

import { parseRuntimeStatus, runtimeStatusMessage } from '../../src/app/status';

describe('runtime status boundary', () => {
  it('accepts exact enumerated modes and locally maps their copy', () => {
    const status = parseRuntimeStatus({ mode: 'official' });
    expect(status).toEqual({ mode: 'official' });
    expect(status && runtimeStatusMessage(status)).toContain('Netflix');
  });

  it('accepts only allowlisted error codes', () => {
    const status = parseRuntimeStatus({
      mode: 'error',
      code: 'authentication_failed',
    });
    expect(status).toEqual({ mode: 'error', code: 'authentication_failed' });
    expect(status && runtimeStatusMessage(status)).toContain('API Key');
    expect(parseRuntimeStatus({ mode: 'error', code: 'Bearer secret' })).toBeNull();
  });

  it('rejects free-form messages and all extra fields', () => {
    expect(parseRuntimeStatus({
      mode: 'error',
      code: 'provider_unavailable',
      message: 'Bearer secret-key',
    })).toBeNull();
    expect(parseRuntimeStatus({ mode: 'official', message: 'secret' })).toBeNull();
  });
});
