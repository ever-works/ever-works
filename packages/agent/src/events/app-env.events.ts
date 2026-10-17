import { BaseEvent } from './base';

/**
 * APW-07 — `app.env.changed` / `app.env.rotated` on the EventEmitter bus
 * (plan §7: "Events (EventEmitter2 + Activity, names only)"; CONTRACTS §6).
 *
 * Until 2026-10-17 APW-07 wrote these two names as Activity rows only, so nothing
 * in the process could react to an env change: APW-05's `AppBuildsListener`
 * subscribed to `app.env.changed` for a re-prepare (plan §7.6: "naming a
 * `build`/`both` entry → prepare within 60 s, debounced 10 s per Work") and never
 * heard one. `AppEnvService` now emits them beside the Activity row.
 *
 * ## Names only, split by phase
 *
 * The payload carries **names and nothing else** — never a value, a length or a
 * hash (FR-8, R8). The names are split by the phase the App spec declares for
 * each (`build`, `runtime`, `both` → both lists), so a consumer can tell "the next
 * Build reads a different value" (`buildPhaseNames` → rebuild) from "the next
 * Deploy does" (`runtimePhaseNames` → redeploy) without re-reading the spec. A
 * name the spec does not declare ("Set by you") is runtime-only, which is how the
 * resolver passes it (`envPhaseOf`'s default).
 */
export interface AppEnvChangedPayload {
    readonly workId: string;
    /** Every name the call changed (set, unset, reset, imported, rotated). */
    readonly names: readonly string[];
    /** Those a Build reads (`build` / `both`): a rebuild applies them. */
    readonly buildPhaseNames: readonly string[];
    /** Those a Deployment reads (`runtime` / `both`): a redeploy applies them. */
    readonly runtimePhaseNames: readonly string[];
}

/** `app.env.changed` — one per `AppEnvService.apply` call that changed anything. */
export class AppEnvChangedEvent extends BaseEvent {
    static EVENT_NAME = 'app.env.changed';

    constructor(public readonly payload: AppEnvChangedPayload) {
        super();
    }

    get workId(): string {
        return this.payload.workId;
    }

    get names(): readonly string[] {
        return this.payload.names;
    }
}

/** `app.env.rotated` — one per `AppEnvService.rotate` of a generated value. */
export class AppEnvRotatedEvent extends BaseEvent {
    static EVENT_NAME = 'app.env.rotated';

    constructor(public readonly payload: AppEnvChangedPayload) {
        super();
    }

    get workId(): string {
        return this.payload.workId;
    }

    get names(): readonly string[] {
        return this.payload.names;
    }
}
