import type { AppUpstreamStateResponse } from '@ever-works/contracts';

/**
 * The Upstream card's Overview-visibility rule, in a module a SERVER component
 * may import.
 *
 * ## Why this module exists (the `/works/[id]` server-render crash)
 *
 * `showUpstreamCardOnOverview` used to be declared in
 * `@/components/works/app/AppUpstreamCard` — a module whose first statement is
 * the `'use client'` directive. The App Work Overview,
 * `app/[locale]/(dashboard)/works/[id]/page.tsx`, is a **server** component and
 * imported the function from that client module anyway, then CALLED it in its
 * render body.
 *
 * A server component that imports a non-component binding across a client
 * boundary does not receive the function. It receives a **client reference** —
 * an opaque bundler placeholder standing in for the module — so the call threw
 * during the page's server render:
 *
 * ```
 * Error: Attempted to call showUpstreamCardOnOverview() from the server but
 * showUpstreamCardOnOverview is on the client. It's not possible to invoke a
 * client function from the server, it can only be rendered as a Component or
 * passed to props of a Client Component.
 * ```
 *
 * Next.js answered the route with its error boundary ("Something went wrong"),
 * so `/works/<id>` broke for **every** Work, App or not — the call is
 * unconditional at `page.tsx:115`, and the failure is request-time only, so
 * `next build` stayed green and only a real request could reveal it. Measured
 * digest of the thrown error: `2265010250`.
 *
 * This is the SAME defect class as the `/new` + `/works/new` crash
 * (`a.filter is not a function`, fixed by moving the chip catalogs to
 * `@/lib/work-kinds/chip-values`). The rule that came out of that one, and that
 * this module exists to satisfy, is:
 *
 *  - **no `'use client'`** — a server component that imports this module gets
 *    the real function, not a client reference;
 *  - **no `server-only`** — the client component that renders the card uses the
 *    same predicate and must keep importing the one definition. This is the
 *    same posture as `@/lib/work-kinds/chip-values` (C22) and
 *    `@/lib/work-kinds/flag-gated-kinds` (APW-01 T20).
 *
 * The client module still EXPORTS the identical name — it re-exports it from
 * here, pointing at this one definition — so every existing consumer and spec
 * keeps working, and the rule still lives in exactly one place.
 *
 * `apps/web/scripts/check-server-client-boundary.mjs` is the mechanical guard
 * for the whole class: it fails when any server component imports a value from
 * a `'use client'` module.
 */

/**
 * Whether the Overview renders the Upstream card at all (plan §5.1,
 * `plan.md:624-627`).
 *
 * Two conditions, both required: a repository with an upstream
 * (`fork` or `private-copy` — a `link` App Work has none) **and** a readiness
 * APW-01's card no longer owns (`ready` or `waiting_for_setup_pr`). Every other
 * state stays on APW-01's card, which is the one that explains a `preparing`,
 * `timed_out` or `failed` repository.
 */
export function showUpstreamCardOnOverview(state: AppUpstreamStateResponse | null): boolean {
    if (!state) {
        return false;
    }

    const hasUpstream = state.relation === 'fork' || state.relation === 'private-copy';
    const readinessSettled =
        state.readiness.state === 'ready' || state.readiness.state === 'waiting_for_setup_pr';

    return hasUpstream && readinessSettled;
}
