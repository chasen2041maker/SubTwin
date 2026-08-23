import type {
  SubtitleCatalogAuthority,
  SubtitleSchedulingScope,
} from '../subtitles/source';
import type {
  TranslationProviderId,
  TranslationProviderSelection,
} from '../translation/types';

export type LanguageRouteMode =
  | 'deepseek'
  | 'disabled'
  | 'discovering'
  | 'google-free'
  | 'missing-English'
  | 'missing-key'
  | 'official'
  | 'provider-unset';

export type LanguageRouteSourceMode =
  | 'external-translation'
  | 'native-only'
  | 'official-alignment';

export interface LanguageRoutingInput {
  readonly enabled: boolean;
  readonly catalogAuthority: SubtitleCatalogAuthority;
  readonly englishAvailable: boolean;
  readonly simplifiedChineseAvailable: boolean;
  readonly provider: TranslationProviderSelection;
  readonly deepseekKeyReady: boolean;
  readonly schedulingScope: SubtitleSchedulingScope;
}

export interface LanguageRoute {
  readonly mode: LanguageRouteMode;
  readonly externalCallsAllowed: boolean;
  readonly provider: TranslationProviderId | null;
  readonly schedulingScope: SubtitleSchedulingScope;
  readonly sourceMode: LanguageRouteSourceMode;
}

export function routeLanguages(input: LanguageRoutingInput): LanguageRoute {
  if (!input.enabled) return nativeOnly('disabled');
  if (input.catalogAuthority !== 'authoritative') {
    return nativeOnly('discovering');
  }
  if (!input.englishAvailable) return nativeOnly('missing-English');
  if (input.simplifiedChineseAvailable) {
    return nativeOnly('official', 'official-alignment');
  }
  if (input.provider === 'unset') return nativeOnly('provider-unset');
  if (input.provider === 'deepseek' && !input.deepseekKeyReady) {
    return nativeOnly('missing-key');
  }

  return {
    mode: input.provider,
    externalCallsAllowed: true,
    provider: input.provider,
    schedulingScope: input.schedulingScope,
    sourceMode: 'external-translation',
  };
}

function nativeOnly(
  mode: Exclude<LanguageRouteMode, TranslationProviderId>,
  sourceMode: LanguageRouteSourceMode = 'native-only',
): LanguageRoute {
  return {
    mode,
    externalCallsAllowed: false,
    provider: null,
    schedulingScope: 'none',
    sourceMode,
  };
}
