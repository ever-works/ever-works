import { APP_LAUNCHER_PIN_LIMIT, type AppLauncherPinLimitErrorBody } from '@ever-works/contracts';

/**
 * APW-11 App Launcher — the typed refusal a save raises when it would leave more
 * than {@link APP_LAUNCHER_PIN_LIMIT} items pinned.
 *
 * Spec FR-25 (`spec.md:287-288`): "At most 6 items are pinned per person per
 * Organization, counting Ever apps and Works together. **A change that would
 * exceed 6 is refused as a whole.**" Plan §4.2 step 3 (plan.md:414-415) and the
 * error table of §4.5 (plan.md:506) make that refusal a `422` carrying exactly
 * `{ code: 'pinLimit', limit: 6 }` — {@link body} is that payload, so the
 * controller never re-states the code or the number.
 *
 * Why an error and not a per-item rejection: the pin budget is a property of the
 * whole arrangement, not of one tile. `AppLauncherRejection` (the `200` answer
 * with `unknownItem` / `cannotHideCurrent`) exists for changes that are invalid
 * on their own; a seventh pin makes the *resulting set* invalid, so the save
 * writes nothing at all and the panel keeps exactly the arrangement it had
 * (FR-62, spec.md:298-302).
 *
 * Shape follows the package's existing typed errors — `AppPortUnavailableError`
 * (`packages/agent/src/app-runtime/ports.ts:84`) and `DeploymentContextResolutionError`:
 * a real `Error` subclass that carries the machine-readable `code` as a readonly
 * property and sets its own `name`, so `instanceof` and a `code` switch both work
 * on either side of a Nest filter.
 */
export class AppLauncherPinLimitError extends Error {
    /** The `code` of the 422 body — the only value the controller may map. */
    readonly code: AppLauncherPinLimitErrorBody['code'] = 'pinLimit';

    /** The limit that was exceeded. Always {@link APP_LAUNCHER_PIN_LIMIT} today. */
    readonly limit: typeof APP_LAUNCHER_PIN_LIMIT;

    constructor(limit: typeof APP_LAUNCHER_PIN_LIMIT = APP_LAUNCHER_PIN_LIMIT) {
        super(`App Launcher: a save may pin at most ${limit} items`);
        this.name = 'AppLauncherPinLimitError';
        this.limit = limit;
    }

    /**
     * The `422` response body of plan §4.5 (plan.md:506).
     *
     * A getter rather than a stored object so a caller cannot mutate the body a
     * second reader is about to serialise; `code` and `limit` are the same two
     * values the typed fields carry.
     */
    get body(): AppLauncherPinLimitErrorBody {
        return { code: this.code, limit: this.limit };
    }
}

/**
 * Whether a caught value is this epic's pin-limit refusal.
 *
 * `instanceof` alone is unreliable across a bundled boundary (the API and the
 * worker may not share a module instance), so the `code` is checked as well —
 * the same belt-and-braces posture the package's other typed errors take, and
 * the reason `code` is a plain readonly property rather than a getter.
 */
export function isAppLauncherPinLimitError(value: unknown): value is AppLauncherPinLimitError {
    if (value instanceof AppLauncherPinLimitError) {
        return true;
    }
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { code?: unknown }).code === 'pinLimit'
    );
}
