/**
 * The chip / work-kind catalogs that a SERVER component and a CLIENT component
 * both need to name — in one module that a server component may import.
 *
 * ## Why this module exists (the `/new` + `/works/new` server-render crash)
 *
 * `ALL_NEW_CHIP_VALUES` used to be declared in
 * `@/components/new/NewPageClient` and `ALL_WORK_KIND_CHIP_VALUES` in
 * `app/[locale]/(dashboard)/works/new/new-work-client` — and BOTH of those
 * modules open with the `'use client'` directive. Their server-component pages
 * imported the arrays from those client modules anyway
 * (`app/[locale]/(dashboard)/new/page.tsx` and
 * `app/[locale]/(dashboard)/works/new/page.tsx`) and handed them straight to
 * `getDisabledWorkKinds`, whose first act was `values.filter(...)`.
 *
 * A server component that imports a NON-component binding across a client
 * boundary does not receive the value. It receives a **client reference** — an
 * opaque bundler placeholder standing in for the real module — so the call
 * threw `TypeError: a.filter is not a function` during the page's server
 * render, which 500s `/new` and `/works/new` for every visitor.
 *
 * Both arrays therefore live here:
 *
 *  - **no `'use client'`** — a server component that imports this module gets
 *    the real array, not a client reference;
 *  - **no `server-only`** — the two chip components are client components and
 *    must keep importing the same catalog. A `server-only` marker would break
 *    them. This is the same posture as `./flag-gated-kinds` (APW-01 T20).
 *
 * The two client modules still EXPORT the identical names — they import from
 * here and re-export — so no consumer, no page and no spec had to change, and
 * there is exactly one definition of each array.
 *
 * Membership and order are a product decision: do not reorder or drop a member
 * here without moving the corresponding assertion in `./chip-values.unit.spec`.
 */

/**
 * Every chip the unified `/new` page can render. `'store'` is deliberately NOT
 * a member — it is appended to {@link ALL_NEW_CHIP_VALUES} as the inert
 * "coming soon" catalog entry.
 */
export type ChipType =
    | 'mission'
    | 'idea'
    | 'agent'
    | 'task'
    | 'website'
    | 'landing-page'
    | 'blog'
    | 'directory'
    | 'awesome-repo'
    | 'repo'
    | 'company';

/**
 * The live `/new` chips, in render order.
 *
 * Spec §6.3 order:
 * `Mission · Idea · Website · Landing Page · Store · Blog · Directory
 *  · Awesome Repo · Knowledge Base · Company`.
 *
 * Live chips below stay in their current order (mission first, ideas
 * second, then content chips). `Company` joins at the end of the live
 * chip list per the spec, sitting next to the inert `store` chip which
 * is appended afterwards.
 */
export const CHIP_ORDER: ChipType[] = [
    'mission',
    'idea',
    'agent',
    'task',
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
    // Self-build slice D (EW-766) — an existing code repository as a Work.
    'repo',
    'company',
];

/**
 * Every chip value whose availability is gated by a `works-<value>`
 * PostHog feature flag (fail-open — see
 * `@/lib/feature-flags/work-kinds`). Includes the live chips (which now
 * cover `company`, graduated in EW-662 Phase 10) plus the inert baseline
 * `store` so the server page can resolve one flag set covering the whole
 * catalog.
 */
export const ALL_NEW_CHIP_VALUES: ReadonlyArray<ChipType | 'store'> = [...CHIP_ORDER, 'store'];

/**
 * The work kinds `/works/new` can create directly. Not exported as a named
 * type before this move — it was module-local to `new-work-client` — so the
 * name is kept here and re-exported from there.
 */
export type InitialWorkKind =
    | 'website'
    | 'landing-page'
    | 'blog'
    | 'directory'
    | 'awesome-repo'
    | 'repo';

/** The `/works/new` work kinds, in render order. */
export const WORK_KIND_ORDER: InitialWorkKind[] = [
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
    // Self-build slice D (EW-766) — an existing code repository as a Work.
    'repo',
];

/**
 * Every work-kind chip value gated by a `works-<value>` PostHog flag
 * (fail-open — see `@/lib/feature-flags/work-kinds`). Live kinds plus the
 * baseline coming-soon `store`/`company` so the server page resolves one
 * flag set covering the whole catalog.
 */
export const ALL_WORK_KIND_CHIP_VALUES: ReadonlyArray<InitialWorkKind | 'store' | 'company'> = [
    ...WORK_KIND_ORDER,
    'store',
    'company',
];
