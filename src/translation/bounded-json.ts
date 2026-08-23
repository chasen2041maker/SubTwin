const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown | null> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return null;

  const declaredLengthHeader = response.headers.get('content-length');
  if (declaredLengthHeader !== null) {
    if (!CONTENT_LENGTH_PATTERN.test(declaredLengthHeader)) {
      await cancelBody(response.body);
      return null;
    }
    const declaredLength = Number(declaredLengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
      await cancelBody(response.body);
      return null;
    }
  }

  if (response.body === null) {
    if (declaredLengthHeader === null) return null;
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) return null;
    return parseJson(text);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximumBytes - totalBytes) {
        await cancelReader(reader);
        return null;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed or cancelled stream may already have released its reader lock.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return parseJson(text);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel('SubTwin response size limit');
  } catch {
    // Rejection is already decided; cancellation is best-effort cleanup.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel('SubTwin response size limit');
  } catch {
    // Rejection is already decided; cancellation is best-effort cleanup.
  }
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
