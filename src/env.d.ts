/**
 * Bindings that `wrangler types` can't see.
 *
 * Secrets are never listed in wrangler.jsonc (that's the point of secrets), and
 * the AI binding is commented out until you choose Workers AI -- so both are
 * declared here to keep the generated Env accurate. Names must match
 * `wrangler secret put <NAME>` and .dev.vars exactly.
 */

interface Env {
  /** Credential for MODEL_PROVIDER. Not needed for "workers-ai" or "mock". */
  MODEL_API_KEY?: string;
  /** Credential for SEARCH_PROVIDER. Not needed when SEARCH_PROVIDER is "none". */
  SEARCH_API_KEY?: string;
  /** Optional. Improves X post reading; oEmbed is used when absent. */
  X_BEARER_TOKEN?: string;
  /** Optional. When set, the API requires this passphrase. */
  APP_PASSWORD?: string;
  /** Present only when the "ai" binding is enabled in wrangler.jsonc. */
  AI?: Ai;
}
