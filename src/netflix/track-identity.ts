const SAFE_TRACK_ID = /^[A-Za-z0-9._:-]+$/u;
const NETFLIX_COMPOSITE_TRACK_ID =
  /^T:[A-Za-z0-9._:-]+(?:;[A-Za-z0-9._:-]+)*;?$/u;

export function canonicalizeNetflixLogicalTrackId(raw: unknown): string | null {
  if (
    typeof raw === 'number' &&
    Number.isSafeInteger(raw) &&
    raw >= 0
  ) {
    return String(raw);
  }
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (candidate.length === 0) return null;
  if (candidate.length <= 128 && SAFE_TRACK_ID.test(candidate)) return candidate;
  if (
    candidate.length <= 512 &&
    candidate.includes(';') &&
    NETFLIX_COMPOSITE_TRACK_ID.test(candidate)
  ) {
    const normalized = candidate.endsWith(';') ? candidate : `${candidate};`;
    return `track_${hash64(normalized)}`;
  }
  return null;
}

function hash64(value: string): string {
  return `${fnv1a(value, 0x811c9dc5)}${fnv1a(
    [...value].reverse().join(''),
    0x9e3779b9,
  )}`;
}

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
