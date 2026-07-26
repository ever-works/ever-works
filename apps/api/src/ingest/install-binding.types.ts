/**
 * Shared shapes for per-workspace / per-installation resolution on the
 * INBOUND receivers (Slack Events, GitHub webhooks).
 *
 * Both receivers used to resolve "the oldest enabled install
 * platform-wide" and attribute every delivery to that one platform user.
 * In a hosted multi-tenant deployment that is a data-isolation defect:
 * a second customer's Slack workspace or GitHub repository would have its
 * messages, diffs and AI replies executed under — and billed to — the
 * first customer's account.
 *
 * The replacement resolves the owner from the external workspace /
 * installation identity carried ON the delivery, in a fixed order:
 *
 *   1. **exact binding** — an `ingest_install_bindings` row for this
 *      workspace names the owner;
 *   2. **single-install fallback** — exactly ONE install is configured, so
 *      there is nothing to disambiguate. Logged as a warning, and the
 *      binding is recorded once the delivery passes signature verification
 *      so the deployment self-migrates onto path 1;
 *   3. **signature proof** — with several installs and no binding, the
 *      raw payload is verified against each candidate's secret. A UNIQUE
 *      cryptographic match is evidence of ownership, not a guess (it does
 *      not help for Slack, where installs of the same app share one
 *      signing secret — those deliveries fall through to 4);
 *   4. **refuse** — anything ambiguous or unknown. Refusal is a clean
 *      no-op: warn log, HTTP 200, nothing ingested, nothing dispatched.
 *      Never a 500, and never a guess.
 */

/** Outcome of resolving an inbound delivery to an owning install. */
export type IngestBindingResolution<TBinding> =
    | { readonly status: 'resolved'; readonly binding: TBinding }
    /** No install is configured at all — the receiver fails closed (401). */
    | { readonly status: 'not-configured' }
    /** Installs exist but none can be attributed to this delivery. */
    | { readonly status: 'unresolved'; readonly reason: IngestBindingRefusal };

/** Stable refusal codes — surfaced in warn logs and asserted by tests. */
export type IngestBindingRefusal =
    /** The delivery names a workspace nothing is bound to. */
    | 'unknown-workspace'
    /** Bound, but the owning install is gone or disabled. */
    | 'bound-install-unavailable'
    /** Bound to a different Slack enterprise than the delivery carries. */
    | 'enterprise-mismatch'
    /** Several installs matched and nothing distinguishes them. */
    | 'ambiguous-install';

/**
 * How the owning install was determined (drives the warn/record logic).
 *
 * `app-install` is the GitHub-only fifth path added by the receiver
 * consolidation: the delivery verified against the PLATFORM GitHub App
 * webhook secret, so the owner is the platform user who installed the
 * App (`github_app_installations.createdByUserId`, or the GitHub user
 * link behind `createdByGithubUserId`). It exists so that installing the
 * GitHub App turns the review loop on with no second setup step — the
 * binding it produces is still written to `ingest_install_bindings`, so
 * there remains exactly ONE install-binding table.
 */
export type IngestBindingMatch = 'binding' | 'single-install' | 'signature' | 'app-install';
