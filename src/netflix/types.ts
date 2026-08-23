import type { AppError } from '../shared/result';
import type {
  SubtitleCatalogAuthority,
  SubtitleSchedulingScope,
  SubtitleSourceTrackLifecycle,
} from '../subtitles/source';

export const NETFLIX_ADAPTER_VERSION = 'netflix-adapter-v1' as const;

export type NetflixAdapterVersion = typeof NETFLIX_ADAPTER_VERSION;
export type NetflixLanguageCategory =
  | 'english'
  | 'other'
  | 'simplified-chinese';

export interface NetflixLanguage {
  readonly tag: string;
  readonly sourceTag: string;
  readonly category: NetflixLanguageCategory;
}

export type NetflixTimedTextHostCategory = 'netflix-timed-text';
export type NetflixTimedTextPathCategory = 'timed-text' | 'ttml' | 'webvtt';

export interface NetflixTimedTextResource {
  readonly resourceId: string;
  readonly trackId: string;
  readonly language: NetflixLanguage;
  readonly hostCategory: NetflixTimedTextHostCategory;
  readonly pathCategory: NetflixTimedTextPathCategory;
}

export interface NetflixCatalogTrack {
  readonly trackId: string;
  readonly language: NetflixLanguage;
}

export interface NetflixTrackCatalog {
  readonly authority: SubtitleCatalogAuthority;
  readonly tracks: readonly NetflixCatalogTrack[];
}

export interface NetflixTrack extends NetflixCatalogTrack {
  readonly active: boolean;
  readonly lifecycle: SubtitleSourceTrackLifecycle;
  readonly resource?: NetflixTimedTextResource;
}

export interface NetflixSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly contentId: string;
  readonly mountId: string;
}

export interface NetflixAdapterState {
  readonly session: NetflixSession;
  readonly catalog: NetflixTrackCatalog;
  readonly tracks: readonly NetflixTrack[];
  readonly externalTranslationAllowed: boolean;
  readonly schedulingScope: SubtitleSchedulingScope;
}

export interface NetflixSessionSeed {
  readonly contentId: string;
  readonly mountId: string;
}

export interface NetflixAdapterOptions {
  readonly nonceFactory?: () => string;
}

export interface NetflixTrackCandidate {
  readonly trackId: string;
  readonly languageTag: string;
  readonly resource?: NetflixTimedTextResource;
}

interface NetflixEventBase {
  readonly adapterVersion: NetflixAdapterVersion;
  readonly sessionId: string;
  readonly generation: number;
}

export interface NetflixCatalogObservedEvent extends NetflixEventBase {
  readonly type: 'catalog-observed';
  readonly authority: SubtitleCatalogAuthority;
  readonly tracks: readonly NetflixTrackCandidate[];
}

export interface NetflixTrackObservedEvent extends NetflixEventBase {
  readonly type: 'track-observed';
  readonly track: NetflixTrackCandidate;
}

export interface NetflixTrackActivityChangedEvent extends NetflixEventBase {
  readonly type: 'track-activity-changed';
  readonly trackId: string;
  readonly active: boolean;
}

export interface NetflixTrackDisposedEvent extends NetflixEventBase {
  readonly type: 'track-disposed';
  readonly trackId: string;
}

export type NetflixSessionTransitionReason = 'episode-change' | 'player-remount';

export interface NetflixSessionTransitionEvent extends NetflixEventBase {
  readonly type: 'session-transition';
  readonly reason: NetflixSessionTransitionReason;
  readonly nextContentId: string;
  readonly nextMountId: string;
}

export type NetflixAdapterEvent =
  | NetflixCatalogObservedEvent
  | NetflixSessionTransitionEvent
  | NetflixTrackActivityChangedEvent
  | NetflixTrackDisposedEvent
  | NetflixTrackObservedEvent;

export type NetflixAdapterErrorCode =
  | 'netflix_adapter_version_mismatch'
  | 'netflix_invalid_timed_text_resource'
  | 'netflix_stale_generation'
  | 'netflix_stale_session'
  | 'netflix_track_missing'
  | 'netflix_unsupported_input';

export type NetflixAdapterError = AppError<NetflixAdapterErrorCode>;
