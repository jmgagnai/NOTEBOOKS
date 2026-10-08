import { ProviderUnavailableError } from '../llm/openrouter.js';
import { IngestionFailure } from './stage.js';

/**
 * What stages 2 and 3 hand `attemptFailed`: a provider outage named as
 * `service-unavailable` (NBK-66), and anything else exactly as thrown, so it
 * records `unexpected`.
 *
 * The llm clients decide what an outage is (see `ProviderUnavailableError`);
 * this only translates it into Ingestion's vocabulary. The translation lives
 * here rather than in src/llm/ because chat and search use the same clients
 * and have no failure reasons.
 */
export function classifyProviderFailure(err: unknown): unknown {
  if (err instanceof ProviderUnavailableError) {
    return new IngestionFailure('service-unavailable', err.message, { cause: err });
  }
  return err;
}
