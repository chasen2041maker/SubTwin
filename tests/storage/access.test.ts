import { describe, expect, it, vi } from 'vitest';

import { restrictStorageToTrustedContexts } from '../../src/storage/access';

describe('extension storage access policy', () => {
  it('restricts local storage before credentials are used', async () => {
    const setAccessLevel = vi.fn().mockResolvedValue(undefined);

    await restrictStorageToTrustedContexts({ setAccessLevel });

    expect(setAccessLevel).toHaveBeenCalledExactlyOnceWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
  });
});
