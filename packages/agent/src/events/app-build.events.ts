import type { AppBuildEventPayload, AppBuildStatus } from '@ever-works/contracts';
import { BaseEvent } from './base';

/**
 * APW-05 T17 — the five `app.build.*` events and the explicit status → event
 * map of plan §7.8 (`plan.md:1520-1580`), `APW05-G05`.
 *
 * ## One family, five names, and `blocked` is deliberately absent
 *
 * CONTRACTS §6 names exactly five build events — `app.build.queued`,
 * `app.build.started`, `app.build.succeeded`, `app.build.failed` and
 * `app.build.cancelled`. `blocked` is a real stored status (`work_builds.status`)
 * and **is not one of them**: a blocked Build publishes nothing
 * (`plan.md:1560`), which is what {@link APP_BUILD_EVENT_CLASSES} encodes as
 * `null` rather than as a sixth class.
 *
 * ## The payload is declared ONCE, in contracts (Resolution R-1)
 *
 * `AppBuildEventPayload` lives in `packages/contracts/src/apps/builds.ts:961`
 * and is re-exported here rather than restated: the web, the API and every
 * subscriber read the same interface, so a field added on one side cannot be
 * invisible on another. It carries **names and ids only** — never a value, an
 * excerpt, a logs-URL token or `blockedDetail` (`plan.md:1547-1549`).
 *
 * ## The status → event map is a lookup, not a template
 *
 * Plan §7.8 replaced the older `app.build.<status>` template with an explicit
 * map. `APP_BUILD_STATUS_EVENT_MAP` / `appBuildEventNameForStatus` in contracts
 * carry the *names*; {@link APP_BUILD_EVENT_CLASSES} carries the *classes*, so
 * `AppBuildsService.publish` (the single Activity + event writer, §7.8) resolves
 * both from the status instead of switching on it. Both are total `Record`s: a
 * status added without an event decision is a compile error, and
 * `__tests__/events.spec.ts` fails if the two maps ever disagree.
 *
 * ## Where these come from, and where they go
 *
 * Every one of them is emitted by `AppBuildsService.publish` — the ONE writer —
 * and by nothing else (`plan.md:1569-1573`). That writer also writes the
 * `app_build` Activity row and calls APW-04's
 * `APP_PROVISION_EVENTS_PORT.buildUpdated(buildId)` for a verification Build, so
 * the three emissions cannot be forgotten separately.
 */

export type { AppBuildEventPayload };

/**
 * The status became `queued` — published once, at row insert
 * (`plan.md:1553`). Insert happens in exactly three places: the webhook/poll
 * consumer creating a push or pull-request Build (§7.5),
 * `AppBuildsService.requestRebuild`, and `AppBuildsService.startVerification`.
 */
export class AppBuildQueuedEvent extends BaseEvent {
    static EVENT_NAME = 'app.build.queued';

    constructor(public readonly payload: AppBuildEventPayload) {
        super();
    }
}

/**
 * The status became `running` — published once, when `startedAt` is first set
 * (`plan.md:1556`). The conditional
 * `UPDATE … SET "startedAt" = :t WHERE id = :id AND "startedAt" IS NULL` is what
 * makes "once" true across repeated `running` snapshots.
 */
export class AppBuildStartedEvent extends BaseEvent {
    static EVENT_NAME = 'app.build.started';

    constructor(public readonly payload: AppBuildEventPayload) {
        super();
    }
}

/**
 * The status became `succeeded` — published once, in `finalize()`
 * (`plan.md:1557`). This is the only event on which `deployable` and
 * `notDeployableReason` are final; on every other event they are `false` and
 * `null` (`plan.md:1535-1536`).
 */
export class AppBuildSucceededEvent extends BaseEvent {
    static EVENT_NAME = 'app.build.succeeded';

    constructor(public readonly payload: AppBuildEventPayload) {
        super();
    }
}

/** The status became `failed` — published once, in `finalize()` (`plan.md:1558`). */
export class AppBuildFailedEvent extends BaseEvent {
    static EVENT_NAME = 'app.build.failed';

    constructor(public readonly payload: AppBuildEventPayload) {
        super();
    }
}

/** The status became `cancelled` — published once, in `finalize()` (`plan.md:1559`). */
export class AppBuildCancelledEvent extends BaseEvent {
    static EVENT_NAME = 'app.build.cancelled';

    constructor(public readonly payload: AppBuildEventPayload) {
        super();
    }
}

/** One of the five event classes. */
export type AppBuildEventClass =
    | typeof AppBuildQueuedEvent
    | typeof AppBuildStartedEvent
    | typeof AppBuildSucceededEvent
    | typeof AppBuildFailedEvent
    | typeof AppBuildCancelledEvent;

/**
 * The explicit status → event map of plan §7.8, as classes.
 *
 * `null` means "publish nothing", and the only member that maps to it is
 * `blocked` (`plan.md:1560`). Total on purpose — see the file docstring.
 */
export const APP_BUILD_EVENT_CLASSES = {
    queued: AppBuildQueuedEvent,
    running: AppBuildStartedEvent,
    succeeded: AppBuildSucceededEvent,
    failed: AppBuildFailedEvent,
    cancelled: AppBuildCancelledEvent,
    blocked: null,
} as const satisfies Record<AppBuildStatus, AppBuildEventClass | null>;
