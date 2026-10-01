/**
 * APW-01 (App Work kind) — the prompted-values port (FR-55).
 *
 * Spec: `docs/specs/features/app-works/APW-01-app-work-kind/spec.md` FR-55;
 * plan §7 (`plan.md:925-930`) is the normative declaration this file
 * implements, name for name and field for field. The adapter that binds it is
 * APW-07's env service, which owns the prompted-origin values once the App spec
 * exists.
 *
 * ## Write-only, once per name
 *
 * `storePrompted` is called once per name, with the answers the member gave at
 * creation (`appEnv` on the create DTO), and it is never paired with a read:
 * no read path returns a stored value, which is what "write-only" means here
 * (`plan.md:922-923`). The port writes values; it never answers with one.
 *
 * ## Secrets (Constitution VII)
 *
 * The values are secrets: they are never logged by this port's contract, not on
 * success, not on failure, and not in an error's message. A dropped value is
 * reported as dropped, never quoted.
 *
 * ## Unbound is "dropped", never a refusal
 *
 * Consumers inject this port `@Optional()`. When it is unbound the member's
 * answers are dropped: the fact that they were dropped is logged, the values
 * themselves are not, and the create still succeeds. A missing adapter is a
 * missing destination for the answers — never a reason to reject the member's
 * request (`plan.md:927-929`).
 *
 * This file is deliberately self-contained: no imports, and no runtime
 * dependency beyond the token below.
 */

/**
 * Where APW-01's captured answers go (`plan.md:925-930`).
 *
 * `storePrompted` is called once per name and must not reject for a reason the
 * member could act on: creation has already succeeded by the time it runs. The
 * contract forbids logging the values.
 */
export interface AppPromptedValuesPort {
    storePrompted(workId: string, values: Record<string, string>): Promise<void>;
}

/**
 * DI token for {@link AppPromptedValuesPort} — bound by APW-07's env service,
 * injected `@Optional()` by APW-01's create path.
 *
 * A symbol, not the class: the implementing service lives in another epic and a
 * class token would make this package import it.
 */
export const APP_PROMPTED_VALUES_PORT = Symbol('APP_PROMPTED_VALUES_PORT');

/**
 * The fail-closed default for {@link AppPromptedValuesPort} — **not bound by
 * any module**.
 *
 * An unbound port means the member's answers are dropped: the values go
 * nowhere, and the only thing recorded is that they were dropped (never the
 * values themselves — they are secrets, Constitution VII). It is deliberately
 * not a refusal and never an error: creation succeeds with or without a
 * destination for the answers, and the member is not asked again.
 */
export class NoopAppPromptedValuesPort implements AppPromptedValuesPort {
    async storePrompted(workId: string, values: Record<string, string>): Promise<void> {
        // Intentionally empty: the answers are dropped, and neither the ids nor
        // the values are logged here — the caller reports the drop.
        void workId;
        void values;
    }
}
