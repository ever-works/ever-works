/**
 * APW-01 (App Work kind) — the Apps-catalog port.
 *
 * Spec: `docs/specs/features/app-works/APW-01-app-work-kind/spec.md`; plan §7
 * (`plan.md:892-924`) is the normative declaration this file implements, name
 * for name and field for field. The adapter that binds it is APW-03's
 * `AppSourceCatalogAdapter` (APW-03 plan §2.7); this epic consumes the token
 * and never reads the Apps catalog repository itself.
 *
 * ## Why the seam is a symbol and not the adapter's class
 *
 * The catalog (its Blueprint entries, aliases, fork network and license
 * registry) is APW-03's data and APW-03's code lives outside this package.
 * A class token would force the agent package to import that adapter, so the
 * token is a `Symbol` and the platform layer binds whichever implementation it
 * has: the dependency runs platform → agent, never the reverse.
 *
 * ## Unbound is "unavailable", never "no match"
 *
 * Consumers inject this port `@Optional()`, and an installation without a
 * catalog must not be told that the repository matched nothing — those are
 * different answers. Unbound, or a call that throws, yields
 * `blueprint.status = 'unavailable'` and `license.class = 'unknown'`
 * (`plan.md:920-921`): the create path still succeeds, the preview just says
 * the catalog could not be consulted, and no license class is ever guessed.
 *
 * ## What a match means, and what `prompts` is not
 *
 * {@link AppSourceCatalogPort.matchBlueprint} answers `null` for **no match, a
 * ref mismatch, or an unconfirmed fork match** (APW-03's resolver semantics).
 * Passing `blueprintId` selects the **explicit** path (APW-03 FR-81); omitting
 * it runs the program's D4 resolution order (manifest → alias → fork network →
 * probe). When an entry declares prompts, `prompts` describes them — and never
 * carries a value. A member's answers are write-only: they go to
 * `APP_PROMPTED_VALUES_PORT` and no read path anywhere returns a stored value
 * (`plan.md:922-923`, FR-55).
 *
 * This file is deliberately self-contained: no imports, and no runtime
 * dependency beyond the token below.
 */

/**
 * The Apps catalog, as APW-01 calls it (`plan.md:897-913`).
 *
 * Both methods may reject; a rejection is treated exactly like "unavailable" by
 * every caller (never as "no match" and never as a guessed license class).
 */
export interface AppSourceCatalogPort {
    /**
     * Resolve a repository to a Blueprint entry, or `null` for no match, a ref
     * mismatch or an unconfirmed fork match.
     *
     * `blueprintId` given ⇒ the explicit path (APW-03 FR-81); omitted ⇒ the
     * program's D4 resolution order (manifest → alias → fork network → probe).
     */
    matchBlueprint(input: { owner: string; repo: string; blueprintId?: string }): Promise<{
        id: string;
        version: string;
        verified: boolean;
        name: string;
        /** How the entry was matched; APW-03's resolver maps its own source union onto this. */
        matchSource: 'manifest' | 'alias' | 'fork' | 'probe' | 'explicit';
        licenseClass?: 'green' | 'amber' | 'red' | 'unknown';
        spdx?: string;
        /** Present only for an entry that declares prompts; values are never returned. */
        prompts?: { name: string; description?: string; required: boolean }[];
        displayName?: string;
    } | null>;

    /**
     * Classify a detected SPDX id when no Blueprint matched — the license
     * preview's `source: 'detected'` branch (`plan.md:918-921`). `null` (no
     * license detected) is a legitimate input and yields `'unknown'`; the
     * adapter must never guess a class from a missing one.
     */
    classifyLicense(spdx: string | null): Promise<'green' | 'amber' | 'red' | 'unknown'>;
}

/**
 * DI token for {@link AppSourceCatalogPort} — bound by APW-03's
 * `AppSourceCatalogAdapter`, injected `@Optional()` by APW-01's create path and
 * license preview.
 *
 * A symbol, not the class: the implementing adapter lives in APW-03 and a class
 * token would make this package import it. Unbound means "catalog
 * unavailable" — never "no match".
 */
export const APP_SOURCE_CATALOG_PORT = Symbol('APP_SOURCE_CATALOG_PORT');
