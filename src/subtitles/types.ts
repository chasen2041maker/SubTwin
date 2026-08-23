import type { AppError } from '../shared/result';

export type SubtitleFormat = 'ttml' | 'webvtt';

export type SubtitleLanguageKind =
  | 'captions'
  | 'descriptions'
  | 'metadata'
  | 'subtitles';

export interface SubtitleLanguage {
  readonly tag: string;
  readonly label?: string;
  readonly kind?: SubtitleLanguageKind;
}

export interface SubtitleCue {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly settings?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SubtitleTrack {
  readonly id: string;
  readonly format: SubtitleFormat;
  readonly language: SubtitleLanguage;
  readonly cues: readonly SubtitleCue[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ParseSubtitleOptions {
  readonly trackId: string;
  readonly language: SubtitleLanguage;
}

export type SubtitleParseErrorCode =
  | 'invalid_ttml'
  | 'invalid_ttml_timing'
  | 'invalid_webvtt'
  | 'invalid_webvtt_timing';

export type SubtitleParseError = AppError<SubtitleParseErrorCode>;
