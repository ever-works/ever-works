/**
 * APW-06 T27 — **the App runtime health service**: FR-47's poll, and the sweep `app-health-poll`
 * (T32) calls once a minute.
 *
 * Spec: `APW-06-app-runtime/spec.md` FR-46 (`spec.md:468-475`, the state the poll writes), FR-47
 * (`:476-481`, the whole rule set), FR-41 (`:442-447`, "its DNS record … is re-checked on every
 * health poll"), ACC-06-32 (`:771`), ACC-06-33 (`:772`). Plan: **§9.3** (`plan.md:1287-1300`, the
 * contract), §7.2 (`:1042-1074`, the columns read and written), §9.4 (`:1326-1348`, the three
 * notification rows and their dedupe keys), §9.2 (`:1245-1248`, the ops this service dispatches
 * and the tick that calls it). Task text: `tasks.md:483-490` (T27).
 *
 * ## What one sweep does
 *
 * 1. **Select** — §9.3's query: `target ≠ 'none' AND paused = false AND removedAt IS NULL AND
 *    currentDeploymentId IS NOT NULL`, ordered by `lastPolledAt NULLS FIRST`, `LIMIT 500`.
 * 2. **Group and bound** — rows are grouped by `clusterFingerprint`, **5 concurrent polls per
 *    cluster**, and **one poll never exceeds 20 s** (both §9.3).
 * 3. **Poll** — `getAppStatus` **plus** the first `GET` smoke check over the public URL through
 *    {@link AppPublicSmokeService}. The in-cluster runner is never used: FR-47 grades the *public*
 *    address, and §5.5's classifier ("only `check_failed` while in-cluster passed is
 *    health-relevant", `plan.md:800-803`) is what turns the smoke result into a verdict input.
 * 4. **Judge** — `down` (`ready = 0` on the primary web component) ▸ `degraded` (any web component
 *    below desired, or the public check failed) ▸ `healthy`; `unreachable` whenever the plugin
 *    could not be dialled at all (credential/connection error, a member the materialised plugin
 *    does not implement, or §9.3's 20 s budget running out).
 * 5. **Decide** — §9.3's streak rules, as a pure function ({@link appHealthStreaks}): the 5th
 *    consecutive failing poll notifies (at most once per 6 h **from runtime state**), the 3rd
 *    consecutive passing poll recovers **only when that streak's down notification was really
 *    created**, and the 10th consecutive unreachable poll notifies once.
 * 6. **Persist** — `recordHealth` (counters, `health`, `lastPolledAt`, `lastHealthNotifiedAt`,
 *    `ingressAddress`) and `saveSnapshot` (`statusSnapshot` / `statusObservedAt`), and emit the
 *    §9.4 event through {@link AppRuntimeEventSink}.
 * 7. **Re-validate the ingress address on every poll** (FR-41): updated when it changes, withdrawn
 *    when it stops being public. Every **10th** poll additionally re-resolves the dependency egress
 *    hosts and dispatches `ingress-reconcile` / `dns-reconcile` on drift.
 *
 * ## `poll()` never throws, and an absent seam is a *named* answer
 *
 * Every collaborator is `@Optional()` and appended in read order, so the class is constructible
 * with **nothing** bound — exactly the shape `app-runtime-deletion.service.ts` (T58) and
 * `app-verification-target.service.ts` (T60) establish. Each absent collaborator has a defined
 * answer and none of them is "pretend it worked":
 *
 * | Absent seam                              | The answer                                                                                                        |
 * | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
 * | `WORK_APP_RUNTIME_STATES` (T17)          | `{ ok: false, reason: 'health_store_unavailable' }` — nothing is selected, nothing is polled, no counter moves     |
 * | a **throwing** selection read            | `health_store_unreadable` — the truth is unknown, so the sweep is not reported as having run                        |
 * | `APP_DEPLOY_SPEC_SOURCE` (APW-03 T12)    | `health_spec_source_unavailable` — without the App spec there is no component list to judge and no check to run      |
 * | `APP_DEPLOY_HOST_SOURCE` (T26)           | `health_host_source_unavailable` — without the published host there is no public address to check                    |
 * | `AppPublicSmokeService` (T23)            | `health_smoke_unavailable` — a status read alone would report `healthy` for an app nobody can reach                  |
 * | `APP_RUNTIME_HEALTH_FACADE` (T20)        | `health_access_unavailable` — no plugin, so no cluster call is even attempted                                        |
 * | the facade **refusing** one Work         | that row is `skipped` (counted) with the facade's own refusal code, never a guessed verdict                          |
 * | `getAppStatus` not on the **materialised** plugin | that row is `skipped` with `op_unsupported_on_target` — the named refusal §9.10 fixes, never a crash        |
 * | the App spec read answering nothing      | that row is `skipped` with `spec_unavailable`                                                                        |
 * | `APP_RUNTIME_EVENT_SINK` (T28)           | the verdict is still recorded; the missing Activity row is logged as a warning                                       |
 * | `APP_RUNTIME_NOTIFICATIONS` (T29)        | the notification is **not** counted and `lastHealthNotifiedAt` is **not** written, so the next poll tries again      |
 * | `APPS_DOMAIN_DNS_SERVICE`                | a rejected address is recorded as withdrawn but the record is left in place and reported                             |
 * | `APP_CLUSTER_OP_DISPATCHER` (T31)        | egress drift is reported as `dispatcher_unavailable` and nothing is dispatched — never faked                          |
 * | `APP_HEALTH_EGRESS_SOURCE` (APW-07)      | the every-10th re-resolution reports `egress_source_unavailable` and dispatches nothing                              |
 *
 * A **skipped** row is never written to: it was deliberately not polled, so its `lastPolledAt` and
 * its counters stay exactly as they were.
 *
 * ## The streak rules, and the one value §7.2 cannot carry
 *
 * §9.4 fixes the dedupe keys as `app-unhealthy:<workId>:<failureStreakStartMs>`,
 * `app-recovered:<workId>:<same failureStreakStartMs>` and
 * `app-cluster-unreachable:<workId>:<unreachableStreakStartMs>`. **§7.2 carries no
 * `failureStreakStartMs` column** (`plan.md:1042-1074` lists `health`, `consecutiveFailures`,
 * `consecutivePasses`, `unreachableStreak`, `lastHealthNotifiedAt`, `lastPolledAt`,
 * `statusSnapshot`, `statusObservedAt`, `ingressAddress` and nothing else), so the only streak
 * handle a later poll can read back is **the moment the failure notification was created** —
 * `lastHealthNotifiedAt`, which is also the value §9.3's "at most one per 6 hours" window is
 * enforced from. That is the value this file passes as `failureStreakStartMs` on both the down and
 * the recovery call, and the reason the recovery key can only ever equal a *down notification that
 * was really created*. The unreachable key's handle is the crossing poll's own moment, for the same
 * reason. Both are reported rather than hidden: a column would make this exact instead of
 * derivable.
 *
 * The same gap applies to §9.3's "every **10th** poll": no column counts polls, so
 * {@link AppHealthService} keeps that count, the last egress observation and the "recovery already
 * sent" marker **in this process**. A worker restart costs at most one extra egress reconcile (an
 * idempotent op) and, at worst, one duplicate recovery notification — which T29's unique
 * `(userId, deduplicationKey)` index blocks anyway.
 *
 * ## Reported, not hidden — the seams whose owner has not landed
 *
 * - **`WORK_APP_RUNTIME_STATES` is imported, never re-declared** (`app-launcher.service.ts:223`).
 *   The *view* below is T17's own method names (`tasks.md:296-299`: `getOrCreate`,
 *   `selectForHealthPoll(limit)`, `recordHealth(...)`, `saveSnapshot(...)`); the swap when T17 lands
 *   is this file's two interfaces shrinking to T17's exports. A second `Symbol` of the same name
 *   would be a different token and T17's one binding would reach only one consumer.
 * - **`selectForHealthPoll` must join the Work's owner.** §9.4's notifications are addressed to a
 *   `userId` and §7.2's own columns carry none (`tenantId` / `organizationId` only), so the view
 *   below asks for `userId` and a row without one is still polled but **not notified** — a
 *   notification with no recipient would be a broadcast.
 * - **`APP_RUNTIME_NOTIFICATIONS` is imported from `app-deploy.orchestrator.ts:174`** (T29's token)
 *   and read here at the three members §9.4's rows name. T29's producer shapes are not fixed
 *   anywhere yet, so the argument object is this file's reading and is marked provisional.
 * - **`APP_CLUSTER_OP_DISPATCHER` is imported from `app-runtime-deletion.service.ts:504`** (T58's
 *   token). Two rival *views* of it already exist in this tree — T58's `dispatch(payload, opts)`
 *   and T26's `dispatchAppClusterOp(payload, opts)` (`app-hosts.service.ts:402-409`) — so
 *   {@link AppHealthOpDispatcher} accepts **either** member and prefers neither: whichever T31
 *   binds is the one that gets called, and neither being present is `dispatcher_unavailable`.
 * - **`APP_INGRESS_RECONCILE_OP` and its payload are T26's** (`app-hosts.service.ts:384-396`) and
 *   are imported; only `dns-reconcile` is declared here, because §9.2 names the op (`plan.md:1247`)
 *   and no file declares its payload yet.
 * - **`APP_HEALTH_EGRESS_SOURCE`** is this file's provisional seam for §9.3's "re-resolve the
 *   dependency egress hosts". Its owner is APW-07 (`AppRuntimeEnvSource.resolve(...).egress`,
 *   `ports.ts:218`), whose full `resolve` needs a stored env context this poll must not assemble;
 *   the swap is a narrow adapter in the module graph.
 * - **The public-address judgement** — FR-41's "only when that address is public" — is
 *   {@link appHealthAddressIsPublic} here. APW06-G20 moves the policy to
 *   `packages/plugin/src/helpers/cluster-address-policy.ts` (`tasks.md:1107-1112`,
 *   `isPublicAddress` / `resolvePublicAddresses`), which does not exist in this tree yet; when it
 *   lands, that helper is the one to import and this function is deleted.
 *
 * ## Events (T28 does not exist yet, so the names are spelled here)
 *
 * §9.4's `app.health.degraded` / `app.health.recovered` / `app.health.unreachable` are emitted
 * through {@link AppRuntimeEventSink} with the payload §9.4:1307 fixes —
 * `{ workId, userId?, target, code?, names? }` and **never** a value, a host, a token or log text.
 * `names` carries component names only, `code` is the named reason (`down`, `degraded`,
 * `public_check_failed`, `components_missing`, `healthy`, `cluster_unreachable`).
 * An event is emitted on a **state transition** (the row's
 * `health` before the poll differs from the verdict), not once per minute: the Activity row says
 * when the app *became* degraded or recovered. The recovery **notification** is stricter than the
 * recovery *event* — §9.3's 3 consecutive passes and a down notification that really happened.
 */

import { isIP } from 'node:net';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AppSpec } from '@ever-works/contracts';
import type {
    AppComponentStatus,
    AppStatusSnapshot,
    AppStatusSpec,
    AppTargetRef,
    IDeploymentPlugin,
} from '@ever-works/plugin';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { bindAppMember } from '../facades/app-runtime.facade';
import {
    APP_DEPLOY_HOST_SOURCE,
    APP_DEPLOY_SPEC_SOURCE,
    type AppDeploySpecSource,
} from './app-deploy-preconditions.service';
import { APP_RUNTIME_NOTIFICATIONS } from './app-deploy.orchestrator';
import { APP_INGRESS_RECONCILE_OP, type AppIngressReconcileOpPayload } from './app-hosts.service';
import {
    AppPublicSmokeService,
    smokeChecksFor,
    type AppPublicSmokeRun,
} from './app-public-smoke.service';
import {
    componentInputs,
    cronInputs,
    jobInputs,
    primaryComponentName,
    smokeInputs,
    urlForHost,
    type AppRenderHostSource,
} from './app-render-input.builder';
import {
    APP_CLUSTER_OP_DISPATCHER,
    APPS_DOMAIN_DNS_SERVICE,
    type AppsDomainDnsService,
} from './app-runtime-deletion.service';
import { APP_RUNTIME_EVENT_SINK, type AppRuntimeEventSink } from './ports';
import { APP_CLUSTER_IO_IN_API, AppClusterIoInApiError } from './worker-context';

/* -------------------------------------------------------------------------- *
 * Constants — every number §9.3, FR-47 and §9.4 fix
 * -------------------------------------------------------------------------- */

/** §9.3: "`LIMIT 500`". The cap `selectForHealthPoll` is asked for, and the most a sweep reports. */
export const APP_HEALTH_POLL_LIMIT = 500;

/** §9.3: "group by `clusterFingerprint`, 5 concurrent per cluster". */
export const APP_HEALTH_CONCURRENCY_PER_CLUSTER = 5;

/** §9.3: "20 s per poll". One poll — its cluster read and its public check — never exceeds it. */
export const APP_HEALTH_POLL_TIMEOUT_MS = 20_000;

/** FR-47: "After 5 consecutive failing polls one notification is sent". */
export const APP_HEALTH_FAILURE_THRESHOLD = 5;

/** FR-47: "after 3 consecutive passing polls a recovery notification follows". */
export const APP_HEALTH_RECOVERY_THRESHOLD = 3;

/** FR-47: "10 consecutive polls that cannot reach the cluster produce **Can't reach your cluster**". */
export const APP_HEALTH_UNREACHABLE_THRESHOLD = 10;

/** FR-47: "at most 1 per App Work per 6 hours", enforced from `lastHealthNotifiedAt` (§9.3:1293-1294). */
export const APP_HEALTH_NOTIFY_WINDOW_MS = 6 * 60 * 60 * 1_000;

/** §9.3: "Every **10th** poll additionally re-resolves the dependency egress hosts". */
export const APP_HEALTH_EGRESS_RESOLVE_EVERY = 10;

/**
 * The window the public check is given, in seconds. FR-47 asks for **one** `GET` over the public
 * address, so the window is one attempt: `AppPublicSmokeService.run` starts an attempt while
 * `window - elapsed > 0` and never retries inside a window that cannot hold another
 * {@link APP_SMOKE_RETRY_S} (10 s). The 20 s per-poll budget is the outer bound and aborts the run
 * through the signal it is handed.
 */
export const APP_HEALTH_SMOKE_WINDOW_S = 1;

/** §7.2:1067's `health` column default — what a row that has never been polled carries. */
export const APP_HEALTH_UNKNOWN = 'unknown';

/** §9.4:1306 — the three event names, equal to the Activity actions. T28's family replaces them. */
export const APP_HEALTH_EVENT_DEGRADED = 'app.health.degraded';
export const APP_HEALTH_EVENT_RECOVERED = 'app.health.recovered';
export const APP_HEALTH_EVENT_UNREACHABLE = 'app.health.unreachable';

/** §9.2:1247 — the second op the every-10th re-resolution dispatches (T26 declares the first). */
export const APP_HEALTH_OP_DNS_RECONCILE = 'dns-reconcile' as const;

/** The `reason` both reconcile ops carry — names only, never a host (§9.4:1307). */
export const APP_HEALTH_REASON_EGRESS_DRIFT = 'egress_drift';

/** §9.10's refusal for a member the materialised plugin does not implement. */
export const APP_HEALTH_CODE_OP_UNSUPPORTED = 'op_unsupported_on_target';

/** A credential or connection error (§9.3:1293) — and the code a timed-out poll carries. */
export const APP_HEALTH_CODE_CLUSTER_UNREACHABLE = 'cluster_unreachable';

/** §9.3's 20 s budget ran out before the plugin answered. */
export const APP_HEALTH_CODE_POLL_TIMEOUT = 'poll_timeout';

/** The plugin answered, but reported no component at all — never read as "healthy". */
export const APP_HEALTH_CODE_NO_COMPONENTS = 'components_missing';

/** The check §9.3 runs over the public address failed (FR-47's second `degraded` clause). */
export const APP_HEALTH_CODE_PUBLIC_CHECK_FAILED = 'public_check_failed';

/** The verdict code `healthy` carries — the same word as the verdict. */
export const APP_HEALTH_CODE_HEALTHY = 'healthy';

/** The verdict code a `down` observation carries. */
export const APP_HEALTH_CODE_DOWN = 'down';

/** A Work whose App spec cannot be read is skipped, never judged against a guessed spec. */
export const APP_HEALTH_CODE_SPEC_UNAVAILABLE = 'spec_unavailable';

/** The published host could not be resolved, so the public half of the poll cannot run. */
export const APP_HEALTH_CODE_HOSTS_UNAVAILABLE = 'hosts_unavailable';

/** The every-10th egress re-resolution found nothing to compare — reported, never a drift verdict. */
export const APP_HEALTH_CODE_EGRESS_SOURCE_UNAVAILABLE = 'egress_source_unavailable';
export const APP_HEALTH_CODE_EGRESS_UNRESOLVED = 'egress_unresolved';

/** The dispatcher refused, or no dispatcher member is bound (§9.3's ops). */
export const APP_HEALTH_CODE_DISPATCHER_UNAVAILABLE = 'dispatcher_unavailable';

/** FR-41's withdrawal could not be carried out: the record is left in place and reported. */
export const APP_HEALTH_CODE_DNS_UNAVAILABLE = 'dns_unavailable';

/* -------------------------------------------------------------------------- *
 * The public contract (`tasks.md:483-490`; `packages/tasks`' `app-health-poll` calls it)
 * -------------------------------------------------------------------------- */

/** FR-46's state, as a poll concludes it. `unreachable` is FR-47's "Can't reach your cluster". */
export type AppHealthVerdict = 'healthy' | 'degraded' | 'down' | 'unreachable';

/**
 * What one sweep reports. `poll()` resolves this shape — always, for every path, including the
 * fail-closed ones where `ok` is false and every counter is zero.
 */
export interface AppHealthPollSummary {
    /** `true` ⇔ the sweep ran. `false` ⇔ it could not (see `reason`). */
    ok: boolean;
    /** A named refusal when `ok` is false; otherwise null. */
    reason: string | null;
    /** Rows the §9.3 selection returned (never more than the 500 cap). */
    selected: number;
    /** Rows polled to a verdict. */
    polled: number;
    /** Rows deliberately not polled (paused, deleting, removed, no access…). */
    skipped: number;
    /**
     * Notifications the streak rules decided to send — **counted when a producer was actually
     * called**: an unbound, refusing or recipient-less producer is logged, never counted, and
     * never recorded as `lastHealthNotifiedAt`.
     */
    notifications: number;
    /** Verdict counts of this sweep. */
    verdicts: Record<AppHealthVerdict, number>;
}

/** The two ways a caller narrows a sweep. Absent ⇒ §9.3's own selection, at its own cap. */
export interface AppHealthPollOptions {
    /** Poll exactly this Work (the manual refresh path); absent ⇒ §9.3's full selection. */
    workId?: string;
    /** Cap on selected rows; §9.3's LIMIT 500 by default. */
    limit?: number;
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — the rules worth testing without a socket
 * -------------------------------------------------------------------------- */

/**
 * §9.3's verdict (`plan.md:1292-1293`), in the plan's own order:
 *
 * 1. `down` — the **primary** web component has `0` ready;
 * 2. `degraded` — any web component with `ready < desired`;
 * 3. `degraded` — the public check failed (FR-47's second clause);
 * 4. `healthy` — otherwise.
 *
 * `unreachable` is **not** decided here: it is the answer when the plugin could not be dialled at
 * all (a credential/connection error, a missing member, or the 20 s budget), and
 * {@link AppHealthService} supplies it before this function is reached.
 *
 * Two absences are deliberately *not* `healthy`, because "no evidence" and "all good" are the two
 * answers a health poll must never confuse:
 *
 * - a snapshot with **no component at all** ⇒ `degraded`;
 * - a **declared** primary that the snapshot does not report ⇒ `degraded` (the one component the
 *   verdict is written about was not observed).
 *
 * A Work with no **web** component (a worker-only App spec) is judged on its components instead:
 * FR-47's three clauses are all phrased about web components, and refusing to grade such an app at
 * all would leave it permanently `degraded`.
 */
export function appHealthVerdict(input: {
    components?: readonly AppComponentStatus[] | null;
    /** `primaryComponentName(spec)` — `domains.primaryComponent`, or the one web component. */
    primaryComponent?: string | null;
    publicCheckFailed?: boolean;
}): AppHealthVerdict {
    const components = (input?.components ?? []).filter((component) => !!component);
    if (!components.length) {
        return 'degraded';
    }

    const web = components.filter((component) => component.role === 'web');
    const judged = web.length > 0 ? web : components;
    const declared = text(input?.primaryComponent);
    const primary = declared
        ? (judged.find((component) => text(component.name) === declared) ?? null)
        : judged.length === 1
          ? judged[0]
          : null;

    if (declared && !primary) {
        return 'degraded';
    }
    if (primary && whole(primary.ready) <= 0) {
        return 'down';
    }
    if (judged.some((component) => whole(component.ready) < whole(component.desired))) {
        return 'degraded';
    }

    return input?.publicCheckFailed === true ? 'degraded' : 'healthy';
}

/** What {@link appHealthStreaks} is asked, straight off the row and this poll's verdict. */
export interface AppHealthStreakInput {
    verdict: AppHealthVerdict;
    /** The row's `health` **before** this poll — `undefined`/`unknown` on a first poll. */
    health?: string | null;
    consecutiveFailures?: number | null;
    consecutivePasses?: number | null;
    unreachableStreak?: number | null;
    /** `lastHealthNotifiedAt` in epoch ms — §9.3's 6 h window and §9.4's streak handle. */
    lastHealthNotifiedAtMs?: number | null;
    /** The handle a recovery has already been sent for, when this process remembers one. */
    recoveredForMs?: number | null;
    nowMs: number;
}

/** What the streak rules decided: the counters to write, and which notifications are due. */
export interface AppHealthStreakOutcome {
    failures: number;
    passes: number;
    unreachable: number;
    /** FR-47: `>= 5` consecutive failing polls, and outside §9.3's 6 h window. */
    notifyUnhealthy: boolean;
    /** FR-47: `>= 3` consecutive passing polls, and a down notification that was really created. */
    notifyRecovered: boolean;
    /** FR-47: the 10th consecutive unreachable poll — the crossing, once per streak. */
    notifyUnreachable: boolean;
    /** §9.4's `<failureStreakStartMs>`: the down notification's own moment, as §7.2 can carry it. */
    failureStreakStartMs: number | null;
    /** `true` ⇔ the verdict differs from the `health` the row carried — §9.4's event is emitted then. */
    transition: boolean;
}

/**
 * FR-47's streak rules (`spec.md:476-481`), as one pure function — because "the 5th poll notifies
 * and not the 4th" is the whole of ACC-06-32 and it must not depend on a database round trip.
 *
 * | Poll                   | `consecutiveFailures` | `consecutivePasses` | `unreachableStreak` | Notification      |
 * | ---------------------- | --------------------- | ------------------- | ------------------- | ----------------- |
 * | `down` / `degraded`    | `+1`                  | `0`                 | `0`                 | at `>= 5`, once per 6 h |
 * | `healthy`              | `0`                   | `+1`                | `0`                 | recovery at `>= 3`, if a down notification exists |
 * | `unreachable`          | `0`                   | `0`                 | `+1`                | at exactly `10`   |
 *
 * **An `unreachable` poll is not a failing poll.** FR-47's failure rule is about the *app*; a
 * cluster nobody can reach says nothing about the app, so it must not push the app towards "down"
 * (that is ACC-06-33's whole point: `unreachable`, **never** `down`). Resetting both app counters
 * is therefore the literal reading of "consecutive": a cluster blip costs at most five more minutes
 * of detection latency, while counting it as a failure would send "App is down" for an app that was
 * never observed to be down.
 */
export function appHealthStreaks(input: AppHealthStreakInput): AppHealthStreakOutcome {
    const nowMs = finite(input?.nowMs) ?? Date.now();
    const failures = whole(input?.consecutiveFailures);
    const passes = whole(input?.consecutivePasses);
    const unreachable = whole(input?.unreachableStreak);
    const previous = normaliseHealth(input?.health);
    const handle = timeMs(input?.lastHealthNotifiedAtMs);

    if (input?.verdict === 'unreachable') {
        const streak = unreachable + 1;

        return {
            failures: 0,
            passes: 0,
            unreachable: streak,
            notifyUnhealthy: false,
            notifyRecovered: false,
            notifyUnreachable: streak === APP_HEALTH_UNREACHABLE_THRESHOLD,
            failureStreakStartMs: null,
            transition: previous !== 'unreachable',
        };
    }

    if (input?.verdict === 'healthy') {
        const nextPasses = passes + 1;

        return {
            failures: 0,
            passes: nextPasses,
            unreachable: 0,
            notifyUnhealthy: false,
            // Both halves of §9.4's rule: the 3rd pass, **and** a failure notification that was
            // really created (`lastHealthNotifiedAt`), not yet recovered from.
            notifyRecovered:
                nextPasses >= APP_HEALTH_RECOVERY_THRESHOLD &&
                handle !== null &&
                timeMs(input?.recoveredForMs) !== handle,
            notifyUnreachable: false,
            failureStreakStartMs: handle,
            transition: previous !== 'healthy',
        };
    }

    const nextFailures = failures + 1;

    return {
        failures: nextFailures,
        passes: 0,
        unreachable: 0,
        // §9.3:1293-1294 — the limit is enforced **from runtime state**, not by the dedupe key, which
        // is why a long outage sends again once the window has passed and a 4-minute one never does.
        notifyUnhealthy:
            nextFailures >= APP_HEALTH_FAILURE_THRESHOLD &&
            (handle === null || nowMs - handle >= APP_HEALTH_NOTIFY_WINDOW_MS),
        notifyRecovered: false,
        notifyUnreachable: false,
        failureStreakStartMs: handle,
        transition: previous !== input?.verdict,
    };
}

/**
 * FR-41's "only when that address is public" (`spec.md:443-444`): whether the address the
 * ingress reported may be published at all, and — on every later poll — whether the record that
 * already points at it must be withdrawn.
 *
 * Provisional (header): the policy's owner is APW06-G20's
 * `packages/plugin/src/helpers/cluster-address-policy.ts`, which does not exist in this tree. The
 * families below are the ones its own test list names (`tasks.md:1108-1109`: "every CIDR,
 * `::ffff:10.0.0.1`, `64:ff9b::a00:1`, a mixed public/private resolution") plus the reserved
 * documentation and benchmarking ranges, which are never a routable ingress.
 *
 * A **hostname** (not an IP literal) answers `true`: whether it resolves to a public address is a
 * DNS question, it is asked by the smoke run's own DNS verdict (`AppPublicSmokeService`,
 * §5.5:800-803), and an ingress controller that reports a hostname (a load balancer's) is ordinary.
 */
export function appHealthAddressIsPublic(value: string | null | undefined): boolean {
    const address = text(value).toLowerCase();
    if (!address) {
        return false;
    }

    const version = isIP(address);
    if (version === 4) {
        return isPublicIpv4(address);
    }
    if (version === 6) {
        return isPublicIpv6(address);
    }

    return true;
}

/**
 * The `AppStatusSpec` §9.3's `getAppStatus` call is made with — assembled from the App spec by
 * **T22's own pure helpers** (`app-render-input.builder.ts:1229-1343`) rather than re-derived here,
 * so the components, their roles, their replica counts, the primary and the job/cron names are the
 * same ones a Deployment renders.
 */
export function appHealthStatusSpec(
    spec: AppSpec | null | undefined,
    namespace: string | null | undefined,
): AppStatusSpec {
    return {
        components: componentInputs(spec, text(namespace)).map((component) => ({
            name: component.name,
            role: component.role,
            replicas: component.replicas,
            primary: component.primary === true,
        })),
        jobs: jobInputs(spec)
            .map((job) => job.name)
            .filter((name) => !!name),
        cron: cronInputs(spec)
            .map((entry) => entry.name)
            .filter((name) => !!name),
    };
}

/**
 * §9.3's ordering, applied by this service as well as by the query: `lastPolledAt NULLS FIRST`,
 * then oldest first, ties keeping the selection's own order.
 *
 * The query owns it (`plan.md:1289-1290`); repeating it here is what makes "the never-polled rows
 * go first" a property a reader — and this file's spec — can see, and what makes the concurrency
 * bound observable: with 5 lanes, the first five rows are the first five polled.
 */
export function orderForPoll<T extends { lastPolledAt?: Date | string | number | null }>(
    rows: readonly T[],
): T[] {
    return [...(rows ?? [])].sort((left, right) => {
        const a = timeMs(left?.lastPolledAt);
        const b = timeMs(right?.lastPolledAt);

        if (a === b) return 0;
        if (a === null) return -1;
        if (b === null) return 1;

        return a - b;
    });
}

/* -------------------------------------------------------------------------- *
 * Provisional seams — each one another owner's, named as its owner fixes it
 * -------------------------------------------------------------------------- */

// ── provisional — APW-06 T17, the runtime state row ──────────────────────────
//
// The token is **not** declared here: APW-11 T5 already declared `WORK_APP_RUNTIME_STATES`
// (`app-launcher.service.ts:222-223`, "bound by APW-06 T17") and it is imported above. A second
// `Symbol('WORK_APP_RUNTIME_STATES')` would be a different token, and T17's single binding would
// then reach only one of its consumers. What follows is the *view* this task needs of the same
// provider, at T17's own method names (`tasks.md:296-299`).

/** One `work_app_runtime_states` row as the health poll reads and writes it (plan §7.2:1042-1074). */
export interface AppHealthStateView {
    workId: string;
    /** §7.2:1048 — `none` · `your-cluster` · `ever-works-apps`. */
    target?: string | null;
    /** What the `AppStatusSpec`'s component list is scoped to (never dialled). */
    namespace?: string | null;
    /** §9.3's grouping key. Rows without one share a single pool (see the class docs). */
    clusterFingerprint?: string | null;
    /** §9.3's `currentDeploymentId IS NOT NULL` — nothing deployed is nothing to poll. */
    currentDeploymentId?: string | null;
    paused?: boolean | null;
    removedAt?: Date | string | number | null;
    /** §9.7's "deleting" flag: an App Work mid-removal is never polled. */
    deletionRequestedAt?: Date | string | number | null;
    /** §7.2:1067 — `unknown` · `healthy` · `degraded` · `down` · `unreachable`. */
    health?: string | null;
    consecutiveFailures?: number | null;
    consecutivePasses?: number | null;
    unreachableStreak?: number | null;
    /** §7.2:1069 — the 6 h window **and** §9.4's streak handle. */
    lastHealthNotifiedAt?: Date | string | number | null;
    lastPolledAt?: Date | string | number | null;
    /** §7.2:1065 — FR-41's address, re-validated on every poll. */
    ingressAddress?: { ip?: string | null; hostname?: string | null } | null;
    /** §7.2:1049 — read for the `http`/`https` of the public URL (T26's own rule). */
    targetSettings?: { tls?: string | null } | null;
    /**
     * The owner the notifications are addressed to. **The join `selectForHealthPoll` must make**:
     * §7.2's own columns carry no user id, and §9.4's producers are per-user.
     */
    userId?: string | null;
}

/** What one poll writes back. Absent members are left exactly as they were. */
export interface AppHealthStatePatch {
    health: AppHealthVerdict;
    consecutiveFailures: number;
    consecutivePasses: number;
    unreachableStreak: number;
    /** §9.3's ordering key, and FR-46's "time it was observed". */
    lastPolledAt: Date;
    /** Written **only** when a failure notification was really created (§9.4's dedupe handle). */
    lastHealthNotifiedAt?: Date;
    /** FR-41: present only when the address changed or was withdrawn. */
    ingressAddress?: { ip: string | null; hostname: string | null } | null;
}

/** APW-06 T17's `WorkAppRuntimeStateRepository`, as this task consumes it. */
export interface AppHealthStateStore {
    /**
     * §9.3's selection (`plan.md:1289-1290`) — `target ≠ 'none' AND paused = false AND
     * removedAt IS NULL AND currentDeploymentId IS NOT NULL`, `lastPolledAt NULLS FIRST`,
     * `LIMIT limit`. A row it returns for a Work whose owner cannot be read arrives without
     * `userId`, and is polled but not notified.
     */
    selectForHealthPoll(limit: number): Promise<readonly AppHealthStateView[] | null | undefined>;
    /** T17's own read, for the manual single-Work path (`tasks.md:296`). */
    getOrCreate(workId: string): Promise<AppHealthStateView | null | undefined>;
    /** T17's `recordHealth(...)`: the counters, `health`, `lastPolledAt`, the two addresses. */
    recordHealth(workId: string, patch: AppHealthStatePatch): Promise<unknown>;
    /** T17's `saveSnapshot(...)`: `statusSnapshot` / `statusObservedAt` (§7.2:1070). */
    saveSnapshot(workId: string, snapshot: AppStatusSnapshot): Promise<unknown>;
}

// ── provisional — APW-06 T20, the facade that assembles cluster access ───────
//
// `AppRuntimeFacadeService.resolveClusterAccess(workId)` is the only place a plugin and a
// credential are assembled (R-5, `plan.md:123-137`, `:943-949`). T58 and T60 each declared their
// own narrow reading of it at their own token; this is the third, and the swap is the same:
// `{ provide: APP_RUNTIME_HEALTH_FACADE, useExisting: AppRuntimeFacadeService }`.
//
// The `outcome` discriminant is a **string** on purpose: this package sets
// `strictNullChecks: false` (`tsconfig.json:23`), under which a boolean discriminant stops
// narrowing — the same reason `AppRuntimeAccessResult` spells it this way
// (`app-runtime.facade.ts:249-251`).

/** Everything the poll needs to dial one Work: the ref, the credential and the plugin itself. */
export interface AppHealthClusterAccess {
    target: string;
    ref: AppTargetRef;
    credential: string;
    plugin: IDeploymentPlugin;
    pluginId?: string | null;
}

/** APW-06 T20's `AppRuntimeFacadeService`, as this task consumes it. */
export interface AppHealthAccessFacade {
    resolveClusterAccess(
        workId: string,
    ): Promise<
        | { outcome: 'access'; access: AppHealthClusterAccess }
        | { outcome: 'refused'; refusal: string }
    >;
}

/** DI token for {@link AppHealthAccessFacade} — bound to T20's `AppRuntimeFacadeService`. */
export const APP_RUNTIME_HEALTH_FACADE = Symbol('APP_RUNTIME_HEALTH_FACADE');

// ── provisional — APW-06 T29, the three notification producers (§9.4:1337-1339) ─
//
// The **token is imported** from `app-deploy.orchestrator.ts:174` (T29's own), never re-declared.
// T29's producer signatures are not fixed by any file in this tree yet — `AppRuntimeNotificationProducers`
// there fixes only the two deploy-time members — so the argument shapes below are this file's
// reading of §9.4's dedupe keys and are marked for the swap.

/** APW-06 T29's notification producers, as §9.3's streak rules call them. */
export interface AppHealthNotificationProducers {
    /** `app_unhealthy` — urgent. Key `app-unhealthy:<workId>:<failureStreakStartMs>`. */
    notifyAppUnhealthy?(args: {
        userId: string;
        workId: string;
        failureStreakStartMs: number;
    }): Promise<void> | void;
    /** `app_recovered` — routine. Key `app-recovered:<workId>:<same failureStreakStartMs>`. */
    notifyAppRecovered?(args: {
        userId: string;
        workId: string;
        failureStreakStartMs: number;
    }): Promise<void> | void;
    /** `app_cluster_unreachable` — urgent. Key `app-cluster-unreachable:<workId>:<unreachableStreakStartMs>`. */
    notifyAppClusterUnreachable?(args: {
        userId: string;
        workId: string;
        unreachableStreakStartMs: number;
    }): Promise<void> | void;
}

// ── provisional — APW-06 T31/T32, the op dispatcher ──────────────────────────
//
// The **token is imported** from `app-runtime-deletion.service.ts:504` (T58's), never re-declared.
// Two views of it already exist in this tree — T58's `dispatch(payload, opts?)` and T26's
// `dispatchAppClusterOp(payload, opts?)` (`app-hosts.service.ts:402-409`) — so this view accepts
// either member, and T31 binding one of them is enough for §9.3's two ops to be dispatched.

/** §9.2:1247's second reconcile op payload — no file declares it yet, so it is declared here. */
export interface AppDnsReconcileOpPayload {
    op: typeof APP_HEALTH_OP_DNS_RECONCILE;
    workId: string;
    /** Why the records are being re-applied — names only, never a host (§9.4:1307). */
    reason: string;
    requestId?: string | null;
}

/** The `app-cluster-op` dispatcher §9.3's drift dispatches through — either member. */
export interface AppHealthOpDispatcher {
    dispatch?(
        payload: AppIngressReconcileOpPayload | AppDnsReconcileOpPayload,
        opts?: { delayMs?: number },
    ): Promise<string | null>;
    dispatchAppClusterOp?(
        payload: AppIngressReconcileOpPayload | AppDnsReconcileOpPayload,
        opts?: { delayMs?: number },
    ): Promise<string | null>;
    isEnabled?(): boolean;
}

// ── provisional — APW-07, the dependency egress hosts §9.3 re-resolves ───────
//
// `AppRuntimeEnvSource.resolve(...).egress` (`ports.ts:218`) is the list itself, but its call takes
// a stored env context (target, URLs, internal URLs, the build commit) that a health poll must not
// reassemble — reading stored values to decide drift is exactly the round trip R-10 forbids. The
// swap is a narrow adapter bound to APW-07's service.

/** APW-07's dependency egress hosts, as §9.3's every-10th poll re-resolves them. */
export interface AppHealthEgressSource {
    /** Hosts only. `null` when the question cannot be answered — never `[]` standing in for "none". */
    resolveEgressHosts(workId: string): Promise<readonly string[] | null | undefined>;
}

/** DI token for {@link AppHealthEgressSource} — bound to APW-07's `AppRuntimeEnvSource` adapter. */
export const APP_HEALTH_EGRESS_SOURCE = Symbol('APP_HEALTH_EGRESS_SOURCE');

/* -------------------------------------------------------------------------- *
 * Internals
 * -------------------------------------------------------------------------- */

/** What one row's poll concluded. A skipped row was deliberately not polled. */
type AppHealthRowOutcome =
    | {
          state: 'polled';
          verdict: AppHealthVerdict;
          /** The named code the log line and the event payload carry. */
          code: string;
          /** Component names only (FR-46's components, never a value). */
          names: string[];
          /** The observation, when there was one — what `saveSnapshot` is written from. */
          snapshot?: AppStatusSnapshot | null;
          /** The address the plugin reported on this poll (FR-41). */
          ingressAddress?: { ip: string | null; hostname: string | null } | null;
      }
    | { state: 'skipped'; code: string };

/** The counters one sweep accumulates. */
interface AppHealthSweepCounts {
    selected: number;
    polled: number;
    skipped: number;
    notifications: number;
    verdicts: Record<AppHealthVerdict, number>;
}

/** A `Promise.race` outcome that never rejects and always says which half won (string discriminant). */
type AppHealthRace<T> =
    | { state: 'settled'; value: T }
    | { state: 'timeout' }
    | { state: 'failed'; error: unknown };

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/**
 * §9.3's health poll: select, group, poll under a 20 s bound and 5 lanes per cluster, judge, decide
 * the streaks, persist, re-validate the ingress address, and — every tenth poll — re-resolve the
 * dependency egress hosts and reconcile on drift.
 */
@Injectable()
export class AppHealthService {
    private readonly logger = new Logger(AppHealthService.name);

    /**
     * How many polls each Work has been given **in this process**, for §9.3's "every 10th poll".
     * §7.2 carries no counter column (header), so a restart re-establishes it from zero — which
     * costs one extra reconcile, an op that is idempotent by construction.
     */
    private readonly pollsPerWork = new Map<string, number>();

    /** The egress set each Work's last every-10th poll resolved, so drift is a comparison. */
    private readonly egressByWork = new Map<string, string>();

    /** The notification handle a recovery has been sent for, so a passing streak sends one. */
    private readonly recoveredFor = new Map<string, number>();

    constructor(
        // The store comes first: everything else is unreachable without it, and the fail-closed
        // answer for its absence is the one `packages/tasks`' tick reports verbatim.
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly runtimeStates?: AppHealthStateStore,
        @Optional()
        @Inject(APP_RUNTIME_HEALTH_FACADE)
        private readonly clusterAccess?: AppHealthAccessFacade,
        @Optional()
        @Inject(APP_DEPLOY_SPEC_SOURCE)
        private readonly specs?: AppDeploySpecSource,
        @Optional()
        @Inject(APP_DEPLOY_HOST_SOURCE)
        private readonly hosts?: AppRenderHostSource,
        @Optional()
        private readonly smoke?: AppPublicSmokeService,
        @Optional()
        @Inject(APP_RUNTIME_EVENT_SINK)
        private readonly events?: AppRuntimeEventSink,
        @Optional()
        @Inject(APP_RUNTIME_NOTIFICATIONS)
        private readonly notifications?: AppHealthNotificationProducers,
        @Optional()
        @Inject(APPS_DOMAIN_DNS_SERVICE)
        private readonly dns?: AppsDomainDnsService,
        @Optional()
        @Inject(APP_CLUSTER_OP_DISPATCHER)
        private readonly ops?: AppHealthOpDispatcher,
        @Optional()
        @Inject(APP_HEALTH_EGRESS_SOURCE)
        private readonly egress?: AppHealthEgressSource,
    ) {}

    /* ---------------------------------------------------------------------- *
     * The one public entry point
     * ---------------------------------------------------------------------- */

    /**
     * Poll §9.3's selection — or exactly one Work, when `options.workId` names one (the manual
     * refresh path of FR-46) — and report what happened.
     *
     * **Never throws.** An unbound or refusing collaborator is a named `reason` with `ok: false`
     * (the programme's fail-closed rule), a single row that fails is a verdict or a `skipped`
     * count, and even a bug in this method comes back as `health_sweep_failed` rather than as an
     * exception the `app-health-poll` tick would have to interpret.
     */
    async poll(options?: AppHealthPollOptions): Promise<AppHealthPollSummary> {
        try {
            return await this.sweep(options ?? {});
        } catch (error) {
            this.logger.warn(`The health sweep failed before it could report: ${errorText(error)}`);
            return refusal('health_sweep_failed');
        }
    }

    /* ---------------------------------------------------------------------- *
     * The sweep
     * ---------------------------------------------------------------------- */

    private async sweep(options: AppHealthPollOptions): Promise<AppHealthPollSummary> {
        const single = text(options?.workId);
        const missing = this.missingCollaborator(!!single);
        if (missing) {
            this.logger.warn(
                `No App Work was polled: ${missing}. The App runtime worker cannot assemble a ` +
                    'health poll without it, and a verdict from half the evidence would be wrong.',
            );
            return refusal(missing);
        }

        const selected = await this.selectRows(single, clampLimit(options?.limit));
        if (selected.state === 'refused') {
            this.logger.warn(`No App Work was polled: ${selected.reason}.`);
            return refusal(selected.reason);
        }

        const counts: AppHealthSweepCounts = {
            selected: selected.rows.length,
            polled: 0,
            skipped: 0,
            notifications: 0,
            verdicts: { healthy: 0, degraded: 0, down: 0, unreachable: 0 },
        };

        const candidates: AppHealthStateView[] = [];
        for (const row of selected.rows) {
            const reason = notPollable(row);
            if (reason) {
                // The query already excludes these (`plan.md:1289`); re-checking costs nothing and
                // means a row that changed between the selection and the poll is skipped rather
                // than written to. A skipped row is never written: it was not polled.
                counts.skipped += 1;
                this.logger.warn(
                    `App Work ${row?.workId ?? '?'} was selected but not polled: ${reason}.`,
                );
                continue;
            }
            candidates.push(row);
        }

        await Promise.all(
            this.groupByCluster(candidates).map((bucket) => this.runPool(bucket, counts)),
        );

        return {
            ok: true,
            reason: null,
            selected: counts.selected,
            polled: counts.polled,
            skipped: counts.skipped,
            notifications: counts.notifications,
            verdicts: counts.verdicts,
        };
    }

    /**
     * Which required collaborator is absent, as a named refusal — or `null` when every one is
     * bound. Checked **before** the selection so a sweep that cannot finish never moves a counter.
     */
    private missingCollaborator(single: boolean): string | null {
        const store = this.runtimeStates;

        if (!hasMember(store, single ? 'getOrCreate' : 'selectForHealthPoll')) {
            return 'health_store_unavailable';
        }
        if (!hasMember(store, 'recordHealth') || !hasMember(store, 'saveSnapshot')) {
            return 'health_store_unavailable';
        }
        if (!hasMember(this.specs, 'getEffectiveSpec')) {
            return 'health_spec_source_unavailable';
        }
        if (!hasMember(this.hosts, 'primaryHost')) {
            return 'health_host_source_unavailable';
        }
        if (!hasMember(this.smoke, 'run')) {
            return 'health_smoke_unavailable';
        }
        if (!hasMember(this.clusterAccess, 'resolveClusterAccess')) {
            return 'health_access_unavailable';
        }

        return null;
    }

    /** §9.3's rows, in §9.3's order, capped at §9.3's limit. */
    private async selectRows(
        workId: string,
        limit: number,
    ): Promise<
        { state: 'rows'; rows: AppHealthStateView[] } | { state: 'refused'; reason: string }
    > {
        try {
            if (workId) {
                const row = await this.runtimeStates.getOrCreate(workId);
                if (!row) {
                    // T17's `getOrCreate` inserts an absent row, so nothing at all means the store
                    // could not answer. The truth is unknown: never report a sweep that ran.
                    return { state: 'refused', reason: 'health_state_unreadable' };
                }

                return { state: 'rows', rows: [row] };
            }

            const rows = await this.runtimeStates.selectForHealthPoll(limit);
            if (!Array.isArray(rows)) {
                return { state: 'refused', reason: 'health_store_unreadable' };
            }

            return { state: 'rows', rows: orderForPoll(rows).slice(0, limit) };
        } catch (error) {
            this.logger.warn(`The App health selection could not be read: ${errorText(error)}`);
            return { state: 'refused', reason: 'health_store_unreadable' };
        }
    }

    /**
     * §9.3's grouping: one pool per `clusterFingerprint`, so two clusters never share a credential's
     * throttle. Rows with no fingerprint share **one** pool — they cannot be told apart, and
     * treating them as one cluster can only ever dial *fewer* calls at once, never more.
     */
    private groupByCluster(rows: readonly AppHealthStateView[]): AppHealthStateView[][] {
        const groups = new Map<string, AppHealthStateView[]>();

        for (const row of rows) {
            const key = text(row?.clusterFingerprint);
            const bucket = groups.get(key);
            if (bucket) {
                bucket.push(row);
            } else {
                groups.set(key, [row]);
            }
        }

        return [...groups.values()];
    }

    /** §9.3's "5 concurrent per cluster", hand-rolled so the bound is a property of this file. */
    private async runPool(rows: AppHealthStateView[], counts: AppHealthSweepCounts): Promise<void> {
        const queue = [...rows];
        const lanes = Math.max(
            1,
            Math.min(APP_HEALTH_CONCURRENCY_PER_CLUSTER, Math.max(1, queue.length)),
        );

        const runLane = async (): Promise<void> => {
            for (;;) {
                // `shift()` is synchronous, so two lanes can never take the same row.
                const row = queue.shift();
                if (!row) return;

                await this.pollRow(row, counts);
            }
        };

        await Promise.all(Array.from({ length: lanes }, () => runLane()));
    }

    /* ---------------------------------------------------------------------- *
     * One row
     * ---------------------------------------------------------------------- */

    /**
     * One poll, under §9.3's 20 s bound and with every outcome counted exactly once.
     *
     * The budget covers what the poll **dials** — the plugin read and the public check. A poll that
     * runs out of budget resolves as `unreachable` with {@link APP_HEALTH_CODE_POLL_TIMEOUT} and is
     * written as such: the plugin that never answered is, from the platform's side, a cluster it
     * could not reach. The abandoned observation is left to settle on its own and its result is
     * dropped, so nothing is ever written twice from one poll.
     */
    private async pollRow(row: AppHealthStateView, counts: AppHealthSweepCounts): Promise<void> {
        const nowMs = Date.now();
        const controller = new AbortController();
        const observation = this.observe(row, controller.signal).then(
            (value): AppHealthRace<AppHealthRowOutcome> => ({ state: 'settled', value }),
            (error): AppHealthRace<AppHealthRowOutcome> => ({ state: 'failed', error }),
        );

        const raced = await this.withBudget(observation, APP_HEALTH_POLL_TIMEOUT_MS, () =>
            controller.abort(),
        );

        if (raced.state === 'timeout') {
            // §9.3's budget expired. The plugin never answered, which from here is a cluster we
            // could not reach — never `down`, because nothing about the app was observed.
            this.logger.warn(
                `The poll of work ${row.workId} did not finish within ` +
                    `${APP_HEALTH_POLL_TIMEOUT_MS} ms: ${APP_HEALTH_CODE_POLL_TIMEOUT}.`,
            );
        }

        const outcome: AppHealthRowOutcome =
            raced.state === 'settled'
                ? raced.value
                : raced.state === 'timeout'
                  ? unreachableOutcome(APP_HEALTH_CODE_POLL_TIMEOUT)
                  : unreachableOutcome(refusalCodeFor(raced.error));

        if (outcome.state === 'skipped') {
            counts.skipped += 1;
            this.logger.warn(
                `App Work ${row.workId} was selected but not polled: ${outcome.code}.`,
            );
            return;
        }

        counts.polled += 1;
        counts.verdicts[outcome.verdict] = (counts.verdicts[outcome.verdict] ?? 0) + 1;

        try {
            counts.notifications += await this.applyOutcome(row, outcome, nowMs);
        } catch (error) {
            // The verdict is counted and logged; a failure while *writing* it must not abandon the
            // rest of the sweep (the next poll re-derives everything from what the row still holds).
            this.logger.warn(
                `The verdict '${outcome.verdict}' of work ${row.workId} could not be applied: ` +
                    `${errorText(error)}`,
            );
        }
    }

    /**
     * Everything one poll learns, and nothing it writes: the access, the spec, the plugin's status,
     * the public check. Resolves — always; a refusal is a `{ state: 'skipped' }` outcome and an
     * error is the `unreachable` verdict (§9.3:1293), never an exception that would abandon the
     * rest of the sweep.
     */
    private async observe(
        row: AppHealthStateView,
        signal: AbortSignal,
    ): Promise<AppHealthRowOutcome> {
        const workId = row.workId;

        let resolved: Awaited<ReturnType<AppHealthAccessFacade['resolveClusterAccess']>>;
        try {
            resolved = await this.clusterAccess.resolveClusterAccess(workId);
        } catch (error) {
            const code = refusalCodeFor(error);
            this.logger.warn(
                `The cluster access of work ${workId} could not be resolved, so nothing was ` +
                    `dialled: ${code}. ${errorText(error)}`,
            );
            return unreachableOutcome(code);
        }

        if (resolved?.outcome !== 'access') {
            // A refusal is a *decision*, not a failure: a Work on `none`, a closed tier or a target
            // that is not checked is skipped with the facade's own code (which is never a value).
            return { state: 'skipped', code: text(resolved?.refusal) || 'target_unavailable' };
        }

        const access = resolved.access;
        // The optional member is presence-checked on the MATERIALISED plugin: the lazy proxy answers
        // a function for every name, so a `typeof` probe against a stub proves nothing
        // (`app-runtime.facade.ts:404-423`).
        const getAppStatus = bindAppMember<
            (
                ref: AppTargetRef,
                credential: string,
                spec: AppStatusSpec,
            ) => Promise<AppStatusSnapshot>
        >(access.plugin, 'getAppStatus');

        if (!getAppStatus) {
            return { state: 'skipped', code: APP_HEALTH_CODE_OP_UNSUPPORTED };
        }

        let spec: AppSpec | null = null;
        try {
            const effective = await this.specs.getEffectiveSpec(workId, null);
            spec = effective?.spec ?? null;
        } catch (error) {
            this.logger.warn(
                `The App spec could not be read for work ${workId}, so its status cannot be ` +
                    `judged: ${errorText(error)}`,
            );
            return { state: 'skipped', code: APP_HEALTH_CODE_SPEC_UNAVAILABLE };
        }

        if (!spec) {
            return { state: 'skipped', code: APP_HEALTH_CODE_SPEC_UNAVAILABLE };
        }

        let snapshot: AppStatusSnapshot;
        try {
            snapshot = await getAppStatus(
                access.ref,
                access.credential,
                appHealthStatusSpec(spec, row.namespace),
            );
        } catch (error) {
            // §9.3:1293's credential/connection error. The plugin was dialled and refused to
            // answer, which is exactly FR-47's "cannot reach the cluster" — never `down`.
            this.logger.warn(
                `The App status of work ${workId} could not be read: ${errorText(error)}`,
            );
            return unreachableOutcome(APP_HEALTH_CODE_CLUSTER_UNREACHABLE);
        }

        if (!snapshot || typeof snapshot !== 'object') {
            return unreachableOutcome(APP_HEALTH_CODE_CLUSTER_UNREACHABLE);
        }

        const components = (snapshot.components ?? []).filter((component) => !!component);
        const primary = text(primaryComponentName(spec));
        const ingressAddress = readAddress(snapshot.ingressAddress);

        let publicCheckFailed = false;
        try {
            publicCheckFailed = await this.runPublicCheck(row, spec, ingressAddress, signal);
        } catch (error) {
            // `runPublicCheck` answers `false` for "no check applies" and throws only when the
            // resolution itself failed — an address nobody could check is not a verified address.
            this.logger.warn(
                `The public check of work ${workId} could not be resolved: ${errorText(error)}`,
            );
            publicCheckFailed = true;
        }

        const verdict = appHealthVerdict({
            components,
            primaryComponent: primary,
            publicCheckFailed,
        });

        return {
            state: 'polled',
            verdict,
            code: verdictCode(verdict, components, publicCheckFailed),
            names: unreadyNames(components, primary),
            snapshot,
            ingressAddress,
        };
    }

    /**
     * `plan.md:1291-1292` — "the first `GET` smoke check over the public URL (runner not used;
     * platform HTTP with the public-smoke classifier)".
     *
     * **One** check, so the poll's public half costs one request rather than the whole set: FR-47
     * names "the first `GET` smoke check", and the checks a `first-deploy`-only entry would add
     * belong to the first Deployment, not to a poll minutes later (T23's own filter,
     * `smokeChecksFor`).
     *
     * A Work with **no published host** runs nothing and is not failed for it: there is no public
     * address to check, which is a state FR-26 step 7 already allows. A smoke run that *throws* is
     * the other case: an address that could not be checked is not a verified address, so the poll
     * degrades — the same direction the classifier takes for a transport failure.
     */
    private async runPublicCheck(
        row: AppHealthStateView,
        spec: AppSpec,
        ingressAddress: { ip: string | null; hostname: string | null } | null,
        signal: AbortSignal,
    ): Promise<boolean> {
        const url = await this.publicUrl(row);
        if (!url) {
            return false;
        }

        const checks = smokeChecksFor(false, smokeInputs(spec));
        if (!checks.length) {
            return false;
        }

        try {
            const run: AppPublicSmokeRun = await this.smoke.run({
                workId: row.workId,
                urls: [url],
                checks: checks.slice(0, 1),
                windowSeconds: APP_HEALTH_SMOKE_WINDOW_S,
                isFirstDeploymentOnCluster: false,
                ingressAddresses: resolvedAddresses(ingressAddress),
                // §9.3's budget, carried into the check itself: the request is aborted when the
                // poll's 20 s run out rather than left writing into a socket nobody awaits.
                signal,
            });

            return run?.healthRelevant === true;
        } catch (error) {
            this.logger.warn(
                `The public check of work ${row.workId} could not be run at all, so the address ` +
                    `is unverified: ${errorText(error)}`,
            );
            return true;
        }
    }

    /** §8.1's primary host, as the URL the public check is made against (T26's own scheme rule). */
    private async publicUrl(row: AppHealthStateView): Promise<string | null> {
        try {
            const resolved = hasMember(this.hosts, 'resolveHosts')
                ? await this.hosts.resolveHosts(row.workId)
                : null;
            const primary =
                text(resolved?.primary) || text(await this.hosts.primaryHost(row.workId));
            const url = text(resolved?.primaryUrl) || urlForHost(primary, row.targetSettings?.tls);

            return url || null;
        } catch (error) {
            // Fail-closed: no URL means the public half of the poll cannot run, and §9.3's verdict
            // must not be concluded from the status half alone.
            this.logger.warn(
                `No published host could be resolved for work ${row.workId}: ${errorText(error)}`,
            );
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * What the poll writes: streaks, notifications, the event, the addresses
     * ---------------------------------------------------------------------- */

    /**
     * §9.3's streak rules, §9.4's three notifications, §9.4's event, §7.2's write, FR-41's two
     * address rules and §9.3's every-10th egress re-resolution — in that order, for one polled row.
     *
     * Returns how many notifications were **really created**; the caller adds them to the summary.
     */
    private async applyOutcome(
        row: AppHealthStateView,
        outcome: Extract<AppHealthRowOutcome, { state: 'polled' }>,
        nowMs: number,
    ): Promise<number> {
        const workId = row.workId;
        const userId = text(row.userId);
        const streaks = appHealthStreaks({
            verdict: outcome.verdict,
            health: row.health,
            consecutiveFailures: row.consecutiveFailures,
            consecutivePasses: row.consecutivePasses,
            unreachableStreak: row.unreachableStreak,
            lastHealthNotifiedAtMs: timeMs(row.lastHealthNotifiedAt),
            recoveredForMs: this.recoveredFor.get(workId) ?? null,
            nowMs,
        });

        let created = 0;
        let notifiedAt: Date | undefined;

        if (streaks.notifyUnreachable) {
            const sent = await this.callProducer('notifyAppClusterUnreachable', {
                userId,
                workId,
                // §9.4's handle. §7.2 carries no `unreachableStreakStartMs` either (header), so the
                // crossing — the moment this notification exists — is the value the key can carry.
                unreachableStreakStartMs: nowMs,
            });
            if (sent) created += 1;
        }

        if (streaks.notifyUnhealthy) {
            const sent = await this.callProducer('notifyAppUnhealthy', {
                userId,
                workId,
                failureStreakStartMs: nowMs,
            });
            if (sent) {
                created += 1;
                // The 6 h window and §9.4's streak handle are the same value, and it is written
                // **only** here: a producer that was not called leaves the window open, so the next
                // failing poll tries again rather than losing the incident.
                notifiedAt = new Date(nowMs);
                this.recoveredFor.delete(workId);
            }
        }

        if (streaks.notifyRecovered) {
            const handle = streaks.failureStreakStartMs;
            const sent = await this.callProducer('notifyAppRecovered', {
                userId,
                workId,
                // The **same** value the down notification's key carried (§9.4:1346), which is what
                // makes "only when that streak's down notification was created" true by construction.
                failureStreakStartMs: handle,
            });
            if (sent) {
                created += 1;
                this.recoveredFor.set(workId, handle);
            }
        }

        if (streaks.transition) {
            await this.emitTransition(row, outcome);
        }

        const ingress = await this.revalidateIngress(row, outcome);
        const patch: AppHealthStatePatch = {
            health: outcome.verdict,
            consecutiveFailures: streaks.failures,
            consecutivePasses: streaks.passes,
            unreachableStreak: streaks.unreachable,
            lastPolledAt: new Date(nowMs),
            ...(notifiedAt ? { lastHealthNotifiedAt: notifiedAt } : {}),
            ...(ingress.changed ? { ingressAddress: ingress.address } : {}),
        };

        await this.persist(row, outcome, patch);
        await this.reResolveEgress(row);

        return created;
    }

    /**
     * §9.4's three events, emitted on a **state transition** (§9.4:1305-1307). The payload is
     * exactly `{ workId, userId?, target, code?, names? }` — component names and coded reasons
     * only, never a value, a host, a token or log text (`spec.md` ACC-06-41).
     */
    private async emitTransition(
        row: AppHealthStateView,
        outcome: Extract<AppHealthRowOutcome, { state: 'polled' }>,
    ): Promise<void> {
        if (!this.events || typeof this.events.emit !== 'function') {
            this.logger.warn(
                `App Work ${row.workId} changed to '${outcome.verdict}' but no event sink is ` +
                    'bound, so no Activity row was written.',
            );
            return;
        }

        const name =
            outcome.verdict === 'unreachable'
                ? APP_HEALTH_EVENT_UNREACHABLE
                : outcome.verdict === 'healthy'
                  ? APP_HEALTH_EVENT_RECOVERED
                  : APP_HEALTH_EVENT_DEGRADED;
        const userId = text(row.userId);

        try {
            await this.events.emit({
                name,
                payload: {
                    workId: row.workId,
                    ...(userId ? { userId } : {}),
                    target: text(row.target),
                    // The named reason — `down`, `degraded`, `public_check_failed`,
                    // `components_missing`, `healthy` or `cluster_unreachable`. A code, never a
                    // value, a host or log text (ACC-06-41).
                    code: outcome.code,
                    // Component names only, and only for the verdicts that have components
                    // (FR-46's components; an unreachable poll observed none).
                    ...(outcome.verdict === 'unreachable' ? {} : { names: outcome.names }),
                },
            });
        } catch (error) {
            this.logger.warn(
                `The '${name}' event of work ${row.workId} could not be emitted: ${errorText(error)}`,
            );
        }
    }

    /**
     * FR-41 (`spec.md:443-444`): the published address is re-validated **on every poll** — "updated
     * if it changes, withdrawn if it stops being public". Returns the patch member only when
     * something changed, so a steady address is not rewritten every minute.
     *
     * A snapshot that reports **no** address leaves the stored one alone: "no probe ran" is not
     * evidence that the address became wrong, and clearing it would drop a working record.
     */
    private async revalidateIngress(
        row: AppHealthStateView,
        outcome: Extract<AppHealthRowOutcome, { state: 'polled' }>,
    ): Promise<{
        changed: boolean;
        address: { ip: string | null; hostname: string | null } | null;
    }> {
        const observed = outcome.ingressAddress ?? null;
        if (!observed) {
            return { changed: false, address: null };
        }

        const stored = readAddress(row.ingressAddress);
        const candidate = observed.ip ?? observed.hostname;

        if (candidate && !appHealthAddressIsPublic(candidate)) {
            // FR-41's withdrawal. The record is what points at the address, so it is what goes; the
            // stored address is cleared in the same write, and a missing DNS seam is *reported*
            // rather than silently skipped (T58's own answer for this seam).
            const removed = await this.callDns((removed) => removed.removeRecord(row.workId));
            this.logger.warn(
                `The ingress address of work ${row.workId} is no longer public, so its managed ` +
                    `record was ${removed ? 'withdrawn' : `left in place (${APP_HEALTH_CODE_DNS_UNAVAILABLE})`}.`,
            );

            return { changed: true, address: null };
        }

        if (sameAddress(stored, observed)) {
            return { changed: false, address: null };
        }

        return { changed: true, address: observed };
    }

    /** §7.2's write: the observation first, then the counters and the two addresses. */
    private async persist(
        row: AppHealthStateView,
        outcome: Extract<AppHealthRowOutcome, { state: 'polled' }>,
        patch: AppHealthStatePatch,
    ): Promise<void> {
        if (outcome.snapshot) {
            try {
                await this.runtimeStates.saveSnapshot(row.workId, outcome.snapshot);
            } catch (error) {
                this.logger.warn(
                    `The status snapshot of work ${row.workId} could not be stored: ${errorText(error)}`,
                );
            }
        }

        try {
            await this.runtimeStates.recordHealth(row.workId, patch);
        } catch (error) {
            // The verdict stands and the log names the failure: a lost write is a delay (the next
            // poll re-derives the streaks from what the row still carries), never a wrong verdict.
            this.logger.warn(
                `The health of work ${row.workId} could not be recorded: ${errorText(error)}`,
            );
        }
    }

    /**
     * §9.3's last sentence: "Every **10th** poll additionally re-resolves the dependency egress
     * hosts … drift there dispatches `ingress-reconcile` / `dns-reconcile`."
     *
     * Drift is a comparison against what the previous every-10th poll resolved — §7.2 stores no
     * egress set and no "applied" set is reachable from here — so the **first** every-10th poll
     * establishes the baseline and cannot dispatch: there is nothing yet for it to differ from.
     * A worker restart therefore delays a reconcile by at most one cadence (ten minutes at
     * FR-47's one-minute tick) rather than losing it. Both ops go through the same `@Optional()`
     * dispatcher; an unbound one is reported as
     * {@link APP_HEALTH_CODE_DISPATCHER_UNAVAILABLE} and nothing is faked.
     */
    private async reResolveEgress(row: AppHealthStateView): Promise<void> {
        const workId = row.workId;
        const polled = (this.pollsPerWork.get(workId) ?? 0) + 1;
        this.pollsPerWork.set(workId, polled);

        if (polled % APP_HEALTH_EGRESS_RESOLVE_EVERY !== 0) {
            return;
        }

        if (!hasMember(this.egress, 'resolveEgressHosts')) {
            this.logger.warn(
                `The ${polled}th poll of work ${workId} should have re-resolved its dependency ` +
                    `egress hosts but no egress source is bound: ${APP_HEALTH_CODE_EGRESS_SOURCE_UNAVAILABLE}.`,
            );
            return;
        }

        let hosts: readonly string[] | null | undefined;
        try {
            hosts = await this.egress.resolveEgressHosts(workId);
        } catch (error) {
            this.logger.warn(
                `The dependency egress hosts of work ${workId} could not be re-resolved: ` +
                    `${errorText(error)}`,
            );
            return;
        }

        if (!hosts) {
            this.logger.warn(
                `The dependency egress hosts of work ${workId} are unknown, so no drift can be ` +
                    `judged: ${APP_HEALTH_CODE_EGRESS_UNRESOLVED}.`,
            );
            return;
        }

        const signature = egressSignature(hosts);
        const previous = this.egressByWork.get(workId);
        this.egressByWork.set(workId, signature);

        if (previous === undefined || previous === signature) {
            return;
        }

        // Names and codes only: the drift is reported by which op ran, never by a host (§9.4:1307).
        await this.dispatch({
            op: APP_INGRESS_RECONCILE_OP,
            workId,
            reason: APP_HEALTH_REASON_EGRESS_DRIFT,
        });
        await this.dispatch({
            op: APP_HEALTH_OP_DNS_RECONCILE,
            workId,
            reason: APP_HEALTH_REASON_EGRESS_DRIFT,
        });
    }

    /** One op through the dispatcher seam — either member T58 or T26 binds. */
    private async dispatch(
        payload: AppIngressReconcileOpPayload | AppDnsReconcileOpPayload,
    ): Promise<boolean> {
        const dispatch =
            typeof this.ops?.dispatch === 'function'
                ? this.ops.dispatch.bind(this.ops)
                : typeof this.ops?.dispatchAppClusterOp === 'function'
                  ? this.ops.dispatchAppClusterOp.bind(this.ops)
                  : null;

        if (!dispatch) {
            this.logger.warn(
                `The '${payload.op}' op of work ${payload.workId} was not dispatched: ` +
                    `${APP_HEALTH_CODE_DISPATCHER_UNAVAILABLE}.`,
            );
            return false;
        }

        try {
            await dispatch(payload);
            return true;
        } catch (error) {
            this.logger.warn(
                `The '${payload.op}' op of work ${payload.workId} could not be dispatched: ` +
                    `${errorText(error)}`,
            );
            return false;
        }
    }

    /** One notification producer call. `false` ⇒ nothing was created, and the caller writes nothing. */
    private async callProducer(
        name: keyof AppHealthNotificationProducers,
        args: {
            userId: string;
            workId: string;
            failureStreakStartMs?: number;
            unreachableStreakStartMs?: number;
        },
    ): Promise<boolean> {
        const workId = args.workId;

        if (!args.userId) {
            // §9.4's rows are per-user; a notification with no recipient would be a broadcast. The
            // row is still polled and its counters written, and the log names the missing join.
            this.logger.warn(
                `App Work ${workId} reached '${name}' but its owner could not be read, so no ` +
                    'notification was created.',
            );
            return false;
        }

        const producer = this.notifications?.[name];
        if (typeof producer !== 'function') {
            this.logger.warn(
                `App Work ${workId} reached '${name}' but that producer is not bound, so no ` +
                    'notification was created.',
            );
            return false;
        }

        try {
            await (producer as (value: typeof args) => Promise<void> | void).call(
                this.notifications,
                args,
            );
            return true;
        } catch (error) {
            this.logger.warn(
                `The '${name}' notification of work ${workId} could not be created: ` +
                    `${errorText(error)}`,
            );
            return false;
        }
    }

    /** FR-41's withdrawal seam — T58's own view and token, reused rather than re-declared. */
    private async callDns(
        action: (dns: AppsDomainDnsService) => Promise<boolean | void>,
    ): Promise<boolean> {
        if (!hasMember(this.dns, 'removeRecord')) {
            return false;
        }

        try {
            await action(this.dns);
            return true;
        } catch (error) {
            this.logger.warn(`The managed DNS record could not be withdrawn: ${errorText(error)}`);
            return false;
        }
    }

    /**
     * §9.3's 20 s budget, as a race that never rejects. `onTimeout` aborts what the poll dialled, so
     * a hung request does not outlive the poll that gave up on it.
     */
    private async withBudget<T>(
        work: Promise<AppHealthRace<T>>,
        ms: number,
        onTimeout: () => void,
    ): Promise<AppHealthRace<T>> {
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
            return await Promise.race([
                work,
                new Promise<AppHealthRace<T>>((resolve) => {
                    timer = setTimeout(
                        () => {
                            try {
                                onTimeout();
                            } catch {
                                // An abort that throws must not stop the poll from resolving.
                            }
                            resolve({ state: 'timeout' });
                        },
                        Math.max(1, ms),
                    );
                }),
            ]);
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }
}

/* -------------------------------------------------------------------------- *
 * Module-private helpers
 * -------------------------------------------------------------------------- */

/** Every counter at zero and `ok: false` — the one shape every fail-closed path answers. */
function refusal(reason: string): AppHealthPollSummary {
    return {
        ok: false,
        reason,
        selected: 0,
        polled: 0,
        skipped: 0,
        notifications: 0,
        verdicts: { healthy: 0, degraded: 0, down: 0, unreachable: 0 },
    };
}

/** A poll that concluded `unreachable` without an observation (FR-47's cluster lane). */
function unreachableOutcome(code: string): AppHealthRowOutcome {
    return {
        state: 'polled',
        verdict: 'unreachable',
        code,
        names: [],
        snapshot: null,
        ingressAddress: null,
    };
}

/** Which verdict code an observation carries — the event payload's `code` (§9.4:1307). */
function verdictCode(
    verdict: AppHealthVerdict,
    components: readonly AppComponentStatus[],
    publicCheckFailed: boolean,
): string {
    if (verdict === 'healthy') return APP_HEALTH_CODE_HEALTHY;
    if (verdict === 'down') return APP_HEALTH_CODE_DOWN;
    if (!components.length) return APP_HEALTH_CODE_NO_COMPONENTS;

    return publicCheckFailed ? APP_HEALTH_CODE_PUBLIC_CHECK_FAILED : 'degraded';
}

/** The components FR-46 blames: those below desired, or the primary when it has none ready. */
function unreadyNames(components: readonly AppComponentStatus[], primary: string | null): string[] {
    const name = text(primary);
    const found = name ? components.find((component) => text(component.name) === name) : undefined;

    if (found && whole(found.ready) <= 0) {
        return [name];
    }

    return components
        .filter((component) => whole(component.ready) < whole(component.desired))
        .map((component) => text(component.name))
        .filter((component) => !!component);
}

/** `true` when a row may be polled at all — §9.3's own WHERE clause, re-checked per row. */
function notPollable(row: AppHealthStateView | null | undefined): string | null {
    if (!row || !text(row.workId)) return 'row_unreadable';
    if (!text(row.target) || text(row.target) === 'none') return 'target_none';
    if (row.paused === true) return 'paused';
    if (timeMs(row.removedAt) !== null) return 'removed';
    if (timeMs(row.deletionRequestedAt) !== null) return 'deleting';
    if (!text(row.currentDeploymentId)) return 'not_deployed';

    return null;
}

/** The named code an error a collaborator threw is reported under. */
function refusalCodeFor(error: unknown): string {
    if (
        error instanceof AppClusterIoInApiError ||
        (error as { code?: unknown })?.code === APP_CLUSTER_IO_IN_API
    ) {
        // §6.2's refusal: this process is the API, which never dials a cluster. Named, not generic.
        return APP_CLUSTER_IO_IN_API.toLowerCase();
    }

    return APP_HEALTH_CODE_CLUSTER_UNREACHABLE;
}

/** §9.3's limit: 500 by default, and never more than 500 however a caller asks. */
function clampLimit(limit: number | null | undefined): number {
    const value = finite(limit);

    return value === null || value < 1
        ? APP_HEALTH_POLL_LIMIT
        : Math.min(APP_HEALTH_POLL_LIMIT, Math.floor(value));
}

/** The addresses a public check may be judged against: the reported IP, else an IP hostname. */
function resolvedAddresses(
    address: { ip: string | null; hostname: string | null } | null,
): string[] {
    const values = [text(address?.ip), text(address?.hostname)].filter(
        (value) => isIP(value) !== 0,
    );

    return [...new Set(values)];
}

/** `{ ip, hostname }` from whatever a row or a snapshot carries — never a guessed address. */
function readAddress(
    value: { ip?: string | null; hostname?: string | null } | null | undefined,
): { ip: string | null; hostname: string | null } | null {
    if (!value) return null;

    const ip = text(value.ip);
    const hostname = text(value.hostname);
    if (!ip && !hostname) return null;

    return { ip: ip || null, hostname: hostname || null };
}

/** Whether two stored addresses are the same address (unset sides compare equal). */
function sameAddress(
    left: { ip: string | null; hostname: string | null } | null,
    right: { ip: string | null; hostname: string | null } | null,
): boolean {
    return text(left?.ip) === text(right?.ip) && text(left?.hostname) === text(right?.hostname);
}

/** The egress set as one comparable value: sorted and de-duplicated, so order is not drift. */
function egressSignature(hosts: readonly string[]): string {
    return [...new Set((hosts ?? []).map((host) => text(host)).filter((host) => !!host))]
        .sort()
        .join('\n');
}

/** §7.2:1067's five values; anything else is `unknown`, which is never `healthy`. */
function normaliseHealth(value: string | null | undefined): string {
    const health = text(value).toLowerCase();

    return health === 'healthy' ||
        health === 'degraded' ||
        health === 'down' ||
        health === 'unreachable'
        ? health
        : APP_HEALTH_UNKNOWN;
}

/** A `Date` / ISO string / epoch-ms value as epoch ms, or `null` when unset or unparseable. */
function timeMs(value: Date | string | number | null | undefined): number | null {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) {
        const at = value.getTime();
        return Number.isFinite(at) ? at : null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    const at = new Date(String(value)).getTime();

    return Number.isFinite(at) ? at : null;
}

/** A finite number, or `null`. */
function finite(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A whole, non-negative counter — a row's `NULL` reads as zero. */
function whole(value: number | null | undefined): number {
    const number = finite(value);

    return number === null ? 0 : Math.max(0, Math.floor(number));
}

/** A trimmed string, or `''` — this file's only reading of a possibly-absent text field. */
function text(value: unknown): string {
    return typeof value === 'string'
        ? value.trim()
        : value === null || value === undefined
          ? ''
          : String(value).trim();
}

/** Whether an injected collaborator really carries a member (a lazy proxy's answer is not one). */
function hasMember(value: unknown, name: string): boolean {
    return typeof (value as Record<string, unknown> | null | undefined)?.[name] === 'function';
}

/** `error.message` when there is one, `String(error)` otherwise. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** RFC1918, loopback, link-local, CGNAT, benchmarking and the reserved documentation ranges. */
function isPublicIpv4(address: string): boolean {
    const octets = address.split('.').map((part) => Number(part));
    if (
        octets.length !== 4 ||
        octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
        return false;
    }

    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && octets[2] === 0) return false;
    if (a === 192 && b === 0 && octets[2] === 2) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && octets[2] === 100) return false;
    if (a === 203 && b === 0 && octets[2] === 113) return false;

    return true;
}

/** The IPv6 families that are never a routable ingress, `::ffff:` and NAT64 forms included. */
function isPublicIpv6(address: string): boolean {
    if (address === '::' || address === '::1') return false;

    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
    if (mapped) {
        return isPublicIpv4(mapped[1]);
    }

    // `64:ff9b::/96` — the well-known NAT64 prefix, which carries an IPv4 address in its last 32 bits.
    const nat64 = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
    if (nat64) {
        const high = parseInt(nat64[1], 16);
        const low = parseInt(nat64[2], 16);

        return isPublicIpv4(
            `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
        );
    }

    const head = address.split(':')[0];
    const first = head ? parseInt(head, 16) : 0;
    if (!Number.isFinite(first)) return false;
    // `fc00::/7` unique-local and `fe80::/10` link-local.
    if ((first & 0xfe00) === 0xfc00) return false;
    if ((first & 0xffc0) === 0xfe80) return false;

    return true;
}
