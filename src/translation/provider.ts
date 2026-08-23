import { err } from '../shared/result';
import type {
  TranslationProvider,
  TranslationProviderId,
  TranslationRequest,
  TranslationResult,
} from './types';

export class TranslationProviderRouter {
  readonly #providers: ReadonlyMap<TranslationProviderId, TranslationProvider>;

  constructor(providers: readonly TranslationProvider[]) {
    this.#providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  async translate(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    if (request.provider === 'unset') {
      return err({
        code: 'provider_unset',
        message: 'No translation provider is selected.',
        retryable: false,
      });
    }

    const provider = this.#providers.get(request.provider);
    if (!provider) {
      return err({
        code: 'provider_unavailable',
        message: 'The selected translation provider is unavailable.',
        retryable: false,
      });
    }

    return provider.translate(request, signal);
  }
}
