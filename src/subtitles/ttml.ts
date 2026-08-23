import { DOMParser, type Element, type Node } from '@xmldom/xmldom';

import { err, type Result } from '../shared/result';
import {
  normalizeSubtitleTrack,
  type SubtitleCueDraft,
} from './normalize';
import type {
  ParseSubtitleOptions,
  SubtitleParseError,
  SubtitleTrack,
} from './types';

const TTML_NAMESPACES = new Set([
  'http://www.w3.org/ns/ttml',
  'http://www.w3.org/2006/10/ttaf1',
]);

interface TimingContext {
  readonly beginMs: number;
  readonly endMs?: number;
}

interface TimingParameters {
  readonly frameRate: number;
  readonly effectiveFrameRate: number;
  readonly subFrameRate: number;
  readonly tickRate: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export function parseTtml(
  input: unknown,
  options: ParseSubtitleOptions,
): Result<SubtitleTrack, SubtitleParseError> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return invalidTtml();
  }

  try {
    const document = new DOMParser({
      onError(level, message) {
        throw new Error(`${level}: ${message}`);
      },
    }).parseFromString(input, 'application/xml');
    const root = document.documentElement;

    if (
      root === null ||
      root.localName !== 'tt' ||
      !isSupportedTtmlNamespace(root.namespaceURI)
    ) {
      return invalidTtml();
    }

    const timing = parseTimingParameters(root);
    if (timing === null) return invalidTtmlTiming();

    const paragraphs = descendantsByLocalName(root, 'p');
    const cues: SubtitleCueDraft[] = [];

    for (const paragraph of paragraphs) {
      const interval = resolveInterval(paragraph, root, timing);
      if (
        interval === null ||
        interval.endMs === undefined ||
        interval.beginMs < 0 ||
        interval.endMs <= interval.beginMs
      ) {
        return invalidTtmlTiming();
      }

      const sourceId = getAttributeByLocalName(paragraph, 'id');
      cues.push({
        startMs: interval.beginMs,
        endMs: interval.endMs,
        text: collectText(paragraph),
        ...(sourceId === null ? {} : { sourceId }),
      });
    }

    const normalized = normalizeSubtitleTrack({
      id: options.trackId,
      format: 'ttml',
      language: options.language,
      cues,
      metadata: timing.metadata,
    });

    return normalized.ok ? normalized : invalidTtml();
  } catch {
    return invalidTtml();
  }
}

function parseTimingParameters(root: Element): TimingParameters | null {
  const frameRateValue = getAttributeByLocalName(root, 'frameRate');
  const multiplierValue = getAttributeByLocalName(root, 'frameRateMultiplier');
  const subFrameRateValue = getAttributeByLocalName(root, 'subFrameRate');
  const tickRateValue = getAttributeByLocalName(root, 'tickRate');

  const frameRate = parsePositiveInteger(frameRateValue) ??
    (frameRateValue === null ? 30 : null);
  const subFrameRate = parsePositiveInteger(subFrameRateValue) ??
    (subFrameRateValue === null ? 1 : null);
  const multiplier = parseMultiplier(multiplierValue);

  if (frameRate === null || subFrameRate === null || multiplier === null) {
    return null;
  }

  const effectiveFrameRate = frameRate * multiplier;
  const defaultTickRate = frameRateValue === null
    ? 1
    : effectiveFrameRate * subFrameRate;
  const tickRate = parsePositiveInteger(tickRateValue) ??
    (tickRateValue === null ? defaultTickRate : null);

  if (tickRate === null || !Number.isFinite(effectiveFrameRate)) return null;

  return {
    frameRate,
    effectiveFrameRate,
    subFrameRate,
    tickRate,
    metadata: Object.freeze({
      frameRate: String(frameRate),
      frameRateMultiplier: multiplierValue?.trim() ?? '1 1',
      tickRate: String(tickRate),
    }),
  };
}

function resolveInterval(
  paragraph: Element,
  root: Element,
  timing: TimingParameters,
): TimingContext | null {
  const ancestors: Element[] = [];
  let current: Node | null = paragraph;

  while (current !== null && current.nodeType === current.ELEMENT_NODE) {
    const element = current as Element;
    ancestors.push(element);
    if (element === root) break;
    current = current.parentNode;
  }

  if (ancestors.at(-1) !== root) return null;

  let context: TimingContext = { beginMs: 0 };
  for (const element of ancestors.reverse()) {
    const resolved = resolveElementInterval(element, context, timing);
    if (resolved === null) return null;
    context = resolved;
  }

  return context;
}

function resolveElementInterval(
  element: Element,
  parent: TimingContext,
  timing: TimingParameters,
): TimingContext | null {
  const beginValue = getAttributeByLocalName(element, 'begin');
  const endValue = getAttributeByLocalName(element, 'end');
  const durationValue = getAttributeByLocalName(element, 'dur');
  const beginOffset = beginValue === null
    ? 0
    : parseTimeExpression(beginValue, timing);

  if (beginOffset === null) return null;
  const beginMs = parent.beginMs + beginOffset;

  let endMs = parent.endMs;
  if (endValue !== null) {
    const endOffset = parseTimeExpression(endValue, timing);
    if (endOffset === null) return null;
    const explicitEnd = parent.beginMs + endOffset;
    endMs = endMs === undefined ? explicitEnd : Math.min(endMs, explicitEnd);
  }

  if (durationValue !== null) {
    const duration = parseTimeExpression(durationValue, timing);
    if (duration === null) return null;
    const durationEnd = beginMs + duration;
    endMs = endMs === undefined ? durationEnd : Math.min(endMs, durationEnd);
  }

  return endMs === undefined ? { beginMs } : { beginMs, endMs };
}

function parseTimeExpression(
  value: string,
  timing: TimingParameters,
): number | null {
  const expression = value.trim();
  const clock = /^(\d{2,}):(\d{2}):(\d{2})(?:\.(\d+)|:(\d+)(?:\.(\d+))?)?$/u.exec(
    expression,
  );

  if (clock !== null) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3]);
    if (minutes > 59 || seconds > 59) return null;

    let totalSeconds = hours * 3_600 + minutes * 60 + seconds;
    const fraction = clock[4];
    const frames = clock[5];
    const subFrames = clock[6];

    if (fraction !== undefined) {
      totalSeconds += Number(`0.${fraction}`);
    } else if (frames !== undefined) {
      const frameCount = Number(frames);
      if (frameCount >= timing.frameRate) return null;
      const subFrameCount = subFrames === undefined ? 0 : Number(subFrames);
      if (subFrameCount >= timing.subFrameRate) return null;
      totalSeconds +=
        (frameCount + subFrameCount / timing.subFrameRate) /
        timing.effectiveFrameRate;
    }

    return Number.isFinite(totalSeconds) ? totalSeconds * 1_000 : null;
  }

  const offset = /^(\d+(?:\.\d+)?)(ms|h|m|s|f|t)$/u.exec(expression);
  if (offset === null) return null;

  const count = Number(offset[1]);
  const metric = offset[2];
  if (metric === undefined) return null;
  const multipliers: Readonly<Record<string, number>> = {
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
    ms: 1,
    f: 1_000 / timing.effectiveFrameRate,
    t: 1_000 / timing.tickRate,
  };
  const milliseconds = count * (multipliers[metric] ?? Number.NaN);

  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function collectText(node: Node): string {
  if (node.nodeType === node.TEXT_NODE || node.nodeType === node.CDATA_SECTION_NODE) {
    return (node.nodeValue ?? '').replace(/\s+/gu, ' ');
  }

  if (
    node.nodeType === node.ELEMENT_NODE &&
    (node as Element).localName === 'br'
  ) {
    return '\n';
  }

  let text = '';
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index);
    if (child !== null) text += collectText(child);
  }
  return text;
}

function descendantsByLocalName(root: Element, localName: string): Element[] {
  const elements: Element[] = [];
  const descendants = root.getElementsByTagName('*');

  for (let index = 0; index < descendants.length; index += 1) {
    const element = descendants.item(index);
    if (
      element !== null &&
      element.localName === localName &&
      element.namespaceURI === root.namespaceURI
    ) {
      elements.push(element);
    }
  }

  return elements;
}

function getAttributeByLocalName(element: Element, localName: string): string | null {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute?.localName === localName) return attribute.value;
  }
  return null;
}

function parsePositiveInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseMultiplier(value: string | null): number | null {
  if (value === null) return 1;
  const match = /^(\d+)\s+(\d+)$/u.exec(value.trim());
  if (match === null) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return numerator > 0 && denominator > 0 ? numerator / denominator : null;
}

function isSupportedTtmlNamespace(namespace: string | null): boolean {
  return namespace === null || namespace === '' || TTML_NAMESPACES.has(namespace);
}

function invalidTtml(): Result<never, SubtitleParseError> {
  return err({
    code: 'invalid_ttml',
    message: 'The TTML document is not valid supported subtitle input.',
    retryable: false,
  });
}

function invalidTtmlTiming(): Result<never, SubtitleParseError> {
  return err({
    code: 'invalid_ttml_timing',
    message: 'The TTML document contains an invalid cue timing expression.',
    retryable: false,
  });
}
