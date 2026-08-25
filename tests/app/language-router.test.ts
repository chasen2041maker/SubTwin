import { describe, expect, it } from 'vitest';

import {
  routeLanguages,
  type LanguageRoute,
  type LanguageRouteMode,
  type LanguageRouteSourceMode,
  type LanguageRoutingInput,
} from '../../src/app/language-router';

const READY_ENGLISH_CATALOG: LanguageRoutingInput = {
  enabled: true,
  catalogAuthority: 'authoritative',
  englishAvailable: true,
  simplifiedChineseAvailable: false,
  provider: 'unset',
  deepseekKeyReady: false,
  schedulingScope: 'bulk',
};

const NATIVE_ONLY_ROUTE = {
  externalCallsAllowed: false,
  provider: null,
  schedulingScope: 'none',
  sourceMode: 'native-only',
} as const;

describe('language routing', () => {
  it.each([
    {
      name: 'extension disabled',
      input: {
        ...READY_ENGLISH_CATALOG,
        enabled: false,
        provider: 'google-free',
      },
      mode: 'disabled',
    },
    {
      name: 'catalog still provisional',
      input: {
        ...READY_ENGLISH_CATALOG,
        catalogAuthority: 'provisional',
        provider: 'google-free',
      },
      mode: 'discovering',
    },
    {
      name: 'authoritative catalog missing English',
      input: {
        ...READY_ENGLISH_CATALOG,
        englishAvailable: false,
        provider: 'google-free',
      },
      mode: 'missing-English',
    },
    {
      name: 'official Simplified Chinese available',
      input: {
        ...READY_ENGLISH_CATALOG,
        simplifiedChineseAvailable: true,
        provider: 'unset',
      },
      mode: 'official',
      sourceMode: 'official-alignment',
    },
    {
      name: 'provider not selected',
      input: READY_ENGLISH_CATALOG,
      mode: 'provider-unset',
    },
    {
      name: 'DeepSeek selected without a ready key',
      input: {
        ...READY_ENGLISH_CATALOG,
        provider: 'deepseek',
      },
      mode: 'missing-key',
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly input: LanguageRoutingInput;
    readonly mode: LanguageRouteMode;
    readonly sourceMode?: LanguageRouteSourceMode;
  }>)('routes $name without external calls', ({ input, mode, sourceMode }) => {
    expect(routeLanguages(input)).toEqual({
      ...NATIVE_ONLY_ROUTE,
      mode,
      sourceMode: sourceMode ?? NATIVE_ONLY_ROUTE.sourceMode,
    });
  });

  it('routes an authoritative English-only catalog to Google Free only', () => {
    expect(routeLanguages({
      ...READY_ENGLISH_CATALOG,
      provider: 'google-free',
    })).toEqual<LanguageRoute>({
      mode: 'google-free',
      externalCallsAllowed: true,
      provider: 'google-free',
      schedulingScope: 'bulk',
      sourceMode: 'external-translation',
    });
  });

  it('honors an explicit Google selection even when Netflix has official Chinese', () => {
    expect(routeLanguages({
      ...READY_ENGLISH_CATALOG,
      provider: 'google-free',
      simplifiedChineseAvailable: true,
    })).toEqual<LanguageRoute>({
      mode: 'google-free',
      externalCallsAllowed: true,
      provider: 'google-free',
      schedulingScope: 'bulk',
      sourceMode: 'external-translation',
    });
  });

  it('honors an explicit DeepSeek selection even when Netflix has official Chinese', () => {
    expect(routeLanguages({
      ...READY_ENGLISH_CATALOG,
      provider: 'deepseek',
      deepseekKeyReady: true,
      simplifiedChineseAvailable: true,
    })).toEqual<LanguageRoute>({
      mode: 'deepseek',
      externalCallsAllowed: true,
      provider: 'deepseek',
      schedulingScope: 'bulk',
      sourceMode: 'external-translation',
    });
  });

  it('routes an authoritative English-only catalog to ready DeepSeek only', () => {
    expect(routeLanguages({
      ...READY_ENGLISH_CATALOG,
      provider: 'deepseek',
      deepseekKeyReady: true,
    })).toEqual<LanguageRoute>({
      mode: 'deepseek',
      externalCallsAllowed: true,
      provider: 'deepseek',
      schedulingScope: 'bulk',
      sourceMode: 'external-translation',
    });
  });

  it('limits translation to the urgent window while the active English source is provisional', () => {
    expect(routeLanguages({
      ...READY_ENGLISH_CATALOG,
      provider: 'google-free',
      schedulingScope: 'urgent-window',
    })).toEqual<LanguageRoute>({
      mode: 'google-free',
      externalCallsAllowed: true,
      provider: 'google-free',
      schedulingScope: 'urgent-window',
      sourceMode: 'external-translation',
    });
  });

  it.each([
    {
      name: 'disabled',
      patch: { enabled: false, provider: 'google-free' } as const,
    },
    {
      name: 'discovering with Google selected',
      patch: {
        catalogAuthority: 'provisional',
        provider: 'google-free',
      } as const,
    },
    {
      name: 'discovering with DeepSeek selected',
      patch: {
        catalogAuthority: 'provisional',
        provider: 'deepseek',
        deepseekKeyReady: true,
      } as const,
    },
    {
      name: 'missing English with Google selected',
      patch: { englishAvailable: false, provider: 'google-free' } as const,
    },
    {
      name: 'missing English with DeepSeek selected',
      patch: {
        englishAvailable: false,
        provider: 'deepseek',
        deepseekKeyReady: true,
      } as const,
    },
    {
      name: 'provider unset',
      patch: { provider: 'unset' } as const,
    },
    {
      name: 'DeepSeek key missing',
      patch: { provider: 'deepseek', deepseekKeyReady: false } as const,
    },
  ])('keeps the $name branch outside external scheduling', ({ patch }) => {
    const route = routeLanguages({ ...READY_ENGLISH_CATALOG, ...patch });

    expect(route.externalCallsAllowed).toBe(false);
    expect(route.provider).toBeNull();
    expect(route.schedulingScope).toBe('none');
  });
});
