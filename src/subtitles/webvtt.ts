import { err, type Result } from '../shared/result';
import {
  normalizeCueText,
  normalizeSubtitleTrack,
  type SubtitleCueDraft,
} from './normalize';
import type {
  ParseSubtitleOptions,
  SubtitleParseError,
  SubtitleTrack,
} from './types';

export function parseWebVtt(
  input: unknown,
  options: ParseSubtitleOptions,
): Result<SubtitleTrack, SubtitleParseError> {
  if (typeof input !== 'string') return invalidWebVtt();

  try {
    const source = input.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
    const lines = source.split('\n');
    const header = lines[0] ?? '';

    if (!/^WEBVTT(?:[ \t][^\n]*)?$/u.test(header) || header.includes('-->')) {
      return invalidWebVtt();
    }

    if (lines.length === 1) {
      return createTrack(options, [], header);
    }

    const separatorIndex = lines.findIndex(
      (line, index) => index > 0 && /^[ \t]*$/u.test(line),
    );
    if (separatorIndex === -1) return invalidWebVtt();

    const body = lines.slice(separatorIndex + 1).join('\n');
    const blocks = body.split(/\n[ \t]*\n/gu);
    const cues: SubtitleCueDraft[] = [];

    for (const block of blocks) {
      const lines = block.split('\n');
      while (lines.at(-1) === '') lines.pop();
      if (lines.length === 0 || lines.every((line) => line.trim() === '')) continue;

      const firstLine = lines[0]?.trim() ?? '';
      if (
        /^NOTE(?:[ \t]|$)/u.test(firstLine) ||
        firstLine === 'STYLE' ||
        firstLine === 'REGION'
      ) {
        continue;
      }

      const timingIndex = firstLine.includes('-->') ? 0 : 1;
      const timingLine = lines[timingIndex];
      if (timingLine === undefined) return invalidWebVttTiming();

      const parsedTiming = parseTimingLine(timingLine);
      if (parsedTiming === null) return invalidWebVttTiming();

      const sourceId = timingIndex === 1 ? firstLine : undefined;
      if (sourceId !== undefined) {
        if (sourceId.length === 0 || sourceId.includes('-->')) {
          return invalidWebVtt();
        }
      }

      const payload = lines.slice(timingIndex + 1).join('\n');
      cues.push({
        startMs: parsedTiming.startMs,
        endMs: parsedTiming.endMs,
        text: normalizeCueText(decodeEntities(stripCueMarkup(payload))),
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(Object.keys(parsedTiming.settings).length === 0
          ? {}
          : { settings: parsedTiming.settings }),
      });
    }

    for (let index = 1; index < cues.length; index += 1) {
      const previous = cues[index - 1];
      const current = cues[index];
      if (previous === undefined || current === undefined) continue;
      if (current.startMs < previous.startMs) return invalidWebVttTiming();
    }

    return createTrack(options, cues, header);
  } catch {
    return invalidWebVtt();
  }
}

interface ParsedTimingLine {
  readonly startMs: number;
  readonly endMs: number;
  readonly settings: Readonly<Record<string, string>>;
}

function parseTimingLine(line: string): ParsedTimingLine | null {
  const match = /^([^ \t]+)[ \t]+-->[ \t]+([^ \t]+)(?:[ \t]+(.+))?$/u.exec(
    line.trim(),
  );
  if (match === null) return null;

  const startMs = parseTimestamp(match[1] ?? '');
  const endMs = parseTimestamp(match[2] ?? '');
  if (startMs === null || endMs === null || endMs <= startMs) return null;

  const settings: Record<string, string> = {};
  const settingText = match[3]?.trim();
  if (settingText) {
    for (const token of settingText.split(/[ \t]+/u)) {
      const setting = /^([a-z][a-z0-9-]*):([^\s:]+)$/iu.exec(token);
      if (setting === null) return null;
      const name = setting[1]?.toLowerCase();
      const value = setting[2];
      if (name === undefined || value === undefined || settings[name] !== undefined) {
        return null;
      }
      settings[name] = value;
    }
  }

  return { startMs, endMs, settings };
}

function parseTimestamp(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/u.exec(value);
  if (match === null) return null;

  const hasHours = match[1] !== undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);

  if (seconds > 59 || (hasHours && minutes > 59)) return null;

  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

function stripCueMarkup(payload: string): string {
  return payload.replace(/<[^>\r\n]*>/gu, '');
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lrm: '\u200E',
  lt: '<',
  nbsp: '\u00A0',
  quot: '"',
  rlm: '\u200F',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/giu,
    (entity, reference: string) => {
      if (!reference.startsWith('#')) return NAMED_ENTITIES[reference] ?? entity;

      const hexadecimal = reference[1]?.toLowerCase() === 'x';
      const digits = reference.slice(hexadecimal ? 2 : 1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (
        !Number.isInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return '\uFFFD';
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function createTrack(
  options: ParseSubtitleOptions,
  cues: readonly SubtitleCueDraft[],
  header: string,
): Result<SubtitleTrack, SubtitleParseError> {
  const annotation = header.slice('WEBVTT'.length).trim();
  const normalized = normalizeSubtitleTrack({
    id: options.trackId,
    format: 'webvtt',
    language: options.language,
    cues,
    ...(annotation.length === 0 ? {} : { metadata: { annotation } }),
  });
  return normalized.ok ? normalized : invalidWebVtt();
}

function invalidWebVtt(): Result<never, SubtitleParseError> {
  return err({
    code: 'invalid_webvtt',
    message: 'The WebVTT document is not valid supported subtitle input.',
    retryable: false,
  });
}

function invalidWebVttTiming(): Result<never, SubtitleParseError> {
  return err({
    code: 'invalid_webvtt_timing',
    message: 'The WebVTT document contains an invalid cue timing line.',
    retryable: false,
  });
}
