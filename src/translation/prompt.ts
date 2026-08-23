import type { TranslationRequest } from './types';

export const DEEPSEEK_PROMPT_VERSION = 'subtwin-translate-v1' as const;

export interface DeepSeekPromptMessages {
  readonly system: string;
  readonly user: string;
}

export function buildDeepSeekPrompt(
  request: TranslationRequest,
): DeepSeekPromptMessages {
  const system = [
    `SubTwin translation contract ${DEEPSEEK_PROMPT_VERSION}.`,
    'Translate only target_cues from English to Simplified Chinese.',
    'surrounding_context is read-only context and must not be translated.',
    'Return only strict JSON: {"translations":[{"id":"cue-id","text":"translation"}]}.',
    'Return every target ID exactly once, preserve IDs, and add no explanations.',
  ].join(' ');

  return {
    system,
    user: JSON.stringify({
      target_language: request.targetLanguage,
      target_cues: request.cues.map(({ id, text }) => ({ id, text })),
      surrounding_context: request.context.map(({ id, text }) => ({ id, text })),
    }),
  };
}
