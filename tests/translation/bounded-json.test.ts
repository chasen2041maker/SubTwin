import { describe, expect, it, vi } from 'vitest';

import { readBoundedJsonResponse } from '../../src/translation/bounded-json';

describe('readBoundedJsonResponse', () => {
  it('rejects an invalid Content-Length and cancels without pulling the body', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, {
      highWaterMark: 0,
    }), {
      headers: { 'content-length': 'not-a-number' },
    });

    await expect(readBoundedJsonResponse(response, 1024)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
  });

  it('does not call an unbounded text fallback when the body and length are absent', async () => {
    const text = vi.fn().mockResolvedValue('{"private":"value"}');
    const response = {
      body: null,
      headers: new Headers(),
      text,
    } as unknown as Response;

    await expect(readBoundedJsonResponse(response, 1024)).resolves.toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it('allows the text fallback only when a body-less response declares a safe length', async () => {
    const text = vi.fn().mockResolvedValue('{"ok":true}');
    const response = {
      body: null,
      headers: new Headers({ 'content-length': '11' }),
      text,
    } as unknown as Response;

    await expect(readBoundedJsonResponse(response, 1024)).resolves.toEqual({ ok: true });
    expect(text).toHaveBeenCalledOnce();
  });
});
