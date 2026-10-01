/**
 * APW-06 T70 — **`AppClusterOpRouter`**: the one place an `app-cluster-op` payload becomes work
 * (plan §9.10:1572-1573, `plan.md:1191-1218`).
 *
 * > `app-cluster-op.router.ts` _(new)_: `handle(payload)` routes by `op`. T48, T58 and T60 register
 * > their ops here; `app-cluster-op.task.ts` delegates to it, **so no op lives in the task file**.
 *
 * ## How an op finds its handler
 *
 * Two ways, and both are honest about what is missing:
 *
 * 1. **The classifier below** — the fifteen ids §9.2 registers, each mapped to the service that owns
 *    it. Four groups:
 *    | Ops | Owner | How the router reaches it |
 *    | --- | --- | --- |
 *    | the nine of §9.10 (`status-refresh` … `ingress-reconcile`) | **T70** | `AppLifecycleOpsService.handle` |
 *    | `delete-app-work` | **T58** | `AppRuntimeDeletionService.handleDeleteAppWork` |
 *    | `verification-deploy` / `-status` / `-destroy` | **T60** | `AppVerificationTargetService.handleVerification*` |
 *    | `prepare-namespace` (T69) · `dns-reconcile` (T48) | not landed | refused `op_handler_unavailable`, naming the file that will register it |
 * 2. **`register(op, handler)`** — the explicit extension point §9.10 asks for ("T48, T58 and T60
 *    register their ops here"). A registered handler always wins over the classifier, so an owner
 *    that lands its own op does not have to be re-classified here. The three landed owners are
 *    reached by **method presence on the injected service**, never by a copy of their logic: T58 and
 *    T60 already expose exactly these methods, and a second implementation in this file would be a
 *    rival to theirs.
 *
 * ## The three rules the router itself keeps
 *
 * - **`unknown_op`** — an id outside §9.2's fifteen is refused before anything is dialled. The task
 *   makes the same check (it is the same list), so a dispatcher typo is named on the first run.
 * - **R-15 — `app_work_deleting`** — every op is refused while the Work's `deletionRequestedAt` is
 *   set. The router makes this check **centrally**, from the runtime-state row, so no handler can
 *   forget it; each handler also keeps its own guard for the paths that reach it directly.
 * - **The outcome is cacheable** — a refusal the router decides still writes
 *   `app-op:<workId>:<requestId>` (`{ op, state: 'failed', code }`, TTL 300 000 ms) when a request id
 *   and a `CACHE_MANAGER` exist, which is what makes a refused op visible in `GET app-status`'s
 *   `ops[]` instead of vanishing (§9.10:1580-1582).
 *
 * ## What is reported, not hidden
 *
 * A missing collaborator, an op whose owner has not landed, a cache that refuses the write, a
 * runtime-state row that cannot be read — each is a named `code` and, where a file is owed, its
 * `missing` path. Nothing here answers `done` for work it did not do.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { CACHE_MANAGER, type Cache } from '../cache';
import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { AppRuntimeDeletionService } from './app-runtime-deletion.service';
import { AppVerificationTargetService } from './app-verification-target.service';
import {
    APP_OP_CACHE_TTL_MS,
    AppLifecycleOpsService,
    appOpCacheKey,
    type AppLifecycleOpPayload,
    type AppLifecycleOpResult,
    type AppLifecycleOpStateStore,
} from './app-lifecycle-ops.service';

/* -------------------------------------------------------------------------- *
 * The op set, and every op's owner
 * -------------------------------------------------------------------------- */

/** `delete-app-work` — T58's op (§9.7, R-15). */
export const APP_CLUSTER_OP_DELETE_WORK = 'delete-app-work' as const;

/** T60's three verification ops (§4.12, R-10). */
export const APP_CLUSTER_OP_VERIFICATION_DEPLOY = 'verification-deploy' as const;
export const APP_CLUSTER_OP_VERIFICATION_STATUS = 'verification-status' as const;
export const APP_CLUSTER_OP_VERIFICATION_DESTROY = 'verification-destroy' as const;

/** T69's op (GAP-06) — registered here when `app-runtime-target.resolver.ts` lands. */
export const APP_CLUSTER_OP_PREPARE_NAMESPACE = 'prepare-namespace' as const;

/** T48's op (§8.3) — registered here when the managed-host resolver lands. */
export const APP_CLUSTER_OP_DNS_RECONCILE = 'dns-reconcile' as const;

/** Every op the task's classifier lets through, in §9.2's own order (`app-cluster-op.task.ts:67-83`). */
export const APP_CLUSTER_OP_IDS = [
    'status-refresh',
    'logs',
    'pause',
    'resume',
    'remove',
    'cancel-deploy',
    'job-run',
    'cluster-check',
    APP_CLUSTER_OP_PREPARE_NAMESPACE,
    'ingress-reconcile',
    APP_CLUSTER_OP_DNS_RECONCILE,
    APP_CLUSTER_OP_DELETE_WORK,
    APP_CLUSTER_OP_VERIFICATION_DEPLOY,
    APP_CLUSTER_OP_VERIFICATION_STATUS,
    APP_CLUSTER_OP_VERIFICATION_DESTROY,
] as const;

export type AppClusterOpId = (typeof APP_CLUSTER_OP_IDS)[number];

/** Which service an op is routed to — the router's own vocabulary, reported in every result. */
export type AppClusterOpRoute =
    | 'registered'
    | 'lifecycle-ops'
    | 'deletion'
    | 'verification'
    | 'unowned';

/** An op whose owner task has not landed: the task that will `register` it, and the file it owes. */
export interface AppClusterOpOwner {
    task: string;
    path: string;
}

/**
 * The two ops §9.2 registers whose owners have not landed.
 *
 * They are **not** refused as `unknown_op`: the id is real and a dispatcher sending it is right —
 * what is missing is the handler, and the answer says which file will bring it.
 */
export const APP_CLUSTER_OP_OWNERS: Readonly<Record<string, AppClusterOpOwner>> = {
    [APP_CLUSTER_OP_PREPARE_NAMESPACE]: {
        task: 'APW-06 T69',
        path: 'packages/agent/src/app-runtime/app-runtime-target.resolver.ts',
    },
    [APP_CLUSTER_OP_DNS_RECONCILE]: {
        task: 'APW-06 T48',
        path: 'packages/agent/src/app-runtime/app-managed-host-root.resolver.ts',
    },
};

/** §9.2's `app-cluster-op` payload: the op, the Work and the op's own fields — ids, never a value. */
export interface AppClusterOpPayload extends AppLifecycleOpPayload {}

/** What one routed op reports. */
export interface AppClusterOpRouterResult {
    op: string;
    workId: string;
    requestId: string | null;
    /** `done` · `failed` · `refused` · `deferred` — the handler's own answer, or the router's refusal. */
    state: 'done' | 'failed' | 'refused' | 'deferred';
    /** The named reason; never a value, host, token or log line. */
    code: string | null;
    /** Where the op was routed. */
    route: AppClusterOpRoute;
    /** The owner file an unowned op is waiting on; `null` when nothing is owed. */
    missing: string | null;
    /** The handler's own answer, verbatim. */
    result: unknown;
    /** `written` · `unbound` · `failed` — what happened to the `app-op:` entry. */
    cache: 'written' | 'unbound' | 'failed' | 'skipped';
}

/** A handler another owner registers: anything that answers a result for one payload. */
export type AppClusterOpHandler = (payload: AppClusterOpPayload) => unknown;

/* -------------------------------------------------------------------------- *
 * Codes
 * -------------------------------------------------------------------------- */

/** An id outside §9.2's fifteen — the dispatcher is wrong, and nothing was dialled. */
export const APP_CLUSTER_OP_CODE_UNKNOWN = 'unknown_op' as const;

/** The id is real, its owner has not landed, and `missing` names the file that will bring it. */
export const APP_CLUSTER_OP_CODE_UNOWNED = 'op_handler_unavailable' as const;

/** R-15 — the Work is being deleted, so no op acts on it. */
export const APP_CLUSTER_OP_CODE_APP_WORK_DELETING = 'app_work_deleting' as const;

/** The runtime-state row could not be read, so the R-15 guard cannot be answered. */
export const APP_CLUSTER_OP_CODE_RUNTIME_STATE_UNREADABLE = 'runtime_state_unreadable' as const;

/** No payload, no Work: there is nothing to route. */
export const APP_CLUSTER_OP_CODE_INVALID_PAYLOAD = 'invalid_payload' as const;

/** A registered or classified handler threw. The run is failed, not silently skipped. */
export const APP_CLUSTER_OP_CODE_HANDLER_FAILED = 'handler_failed' as const;

/* -------------------------------------------------------------------------- *
 * The router
 * -------------------------------------------------------------------------- */

/** A trimmed string, or `''`. */
function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** `error.message` when there is one, `String(error)` otherwise, one line and bounded. */
function messageOf(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return String(message || 'unknown error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

/** A method that is present and callable on an `@Optional()` collaborator. */
function hasMember<T>(holder: unknown, name: string): holder is Record<string, T> {
    return !!holder && typeof (holder as Record<string, unknown>)[name] === 'function';
}

/** The three `AppVerificationTargetService` methods T60's op ids map to. */
const VERIFICATION_MEMBERS: Readonly<Record<string, string>> = {
    [APP_CLUSTER_OP_VERIFICATION_DEPLOY]: 'handleVerificationDeploy',
    [APP_CLUSTER_OP_VERIFICATION_STATUS]: 'handleVerificationStatus',
    [APP_CLUSTER_OP_VERIFICATION_DESTROY]: 'handleVerificationDestroy',
};

/**
 * The router of §9.10. Constructed by the worker module and by the two task files that boot it;
 * every collaborator is `@Optional()` so a lean context still routes what it can and names what it
 * cannot.
 */
@Injectable()
export class AppClusterOpRouter {
    private readonly logger = new Logger(AppClusterOpRouter.name);

    /** The explicit registrations, which always win over the classifier. */
    private readonly handlers = new Map<string, AppClusterOpHandler>();

    constructor(
        @Optional()
        @Inject(AppLifecycleOpsService)
        private readonly ops?: AppLifecycleOpsService,
        @Optional()
        @Inject(AppRuntimeDeletionService)
        private readonly deletion?: AppRuntimeDeletionService,
        @Optional()
        @Inject(AppVerificationTargetService)
        private readonly verification?: AppVerificationTargetService,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: AppLifecycleOpStateStore,
        @Optional()
        @Inject(CACHE_MANAGER)
        private readonly cache?: Cache,
    ) {}

    /* ---------------------------------------------------------------------- *
     * The extension point §9.10 names
     * ---------------------------------------------------------------------- */

    /**
     * Register one op's handler — T48, T58, T60 and T69 use this, and a re-registration replaces
     * the previous handler (idempotent, so a hot reload cannot end up with two).
     */
    register(op: string, handler: AppClusterOpHandler): void {
        const id = text(op);
        if (!id || typeof handler !== 'function') {
            throw new Error('register(op, handler) needs an op id and a function.');
        }
        this.handlers.set(id, handler);
    }

    /** Which ops this router can dispatch right now — the classifier's answer plus the registrations. */
    canHandle(op: string): boolean {
        return this.route(text(op)) !== 'unowned';
    }

    /** Where an op would go, without dispatching it. */
    route(op: string): AppClusterOpRoute {
        if (this.handlers.has(op)) {
            return 'registered';
        }
        if ((APP_CLUSTER_OP_IDS as readonly string[]).includes(op)) {
            if ((VERIFICATION_MEMBERS[op] ?? '') !== '') {
                return 'verification';
            }
            if (op === APP_CLUSTER_OP_DELETE_WORK) {
                return 'deletion';
            }
            if ((APP_CLUSTER_OP_OWNERS[op] ?? null) !== null) {
                return 'unowned';
            }
            return 'lifecycle-ops';
        }
        return 'unowned';
    }

    /* ---------------------------------------------------------------------- *
     * The one entry the task uses
     * ---------------------------------------------------------------------- */

    /**
     * Route one payload by `op`.
     *
     * Nothing here throws: an unknown id, an unowned op, a held deletion and a throwing handler are
     * four named answers, because the task reports whatever comes back and a throw would lose the
     * difference between "refused" and "the worker died".
     */
    async handle(payload: AppClusterOpPayload): Promise<AppClusterOpRouterResult> {
        const op = text(payload?.op);
        const workId = text(payload?.workId);
        const requestId = text(payload?.requestId) || null;

        if (!op || !workId) {
            return this.refuse(payload, APP_CLUSTER_OP_CODE_INVALID_PAYLOAD, 'unowned', null, {
                reason: op ? 'no workId was carried' : 'no op was carried',
            });
        }

        if (!(APP_CLUSTER_OP_IDS as readonly string[]).includes(op)) {
            return this.refuse(payload, APP_CLUSTER_OP_CODE_UNKNOWN, 'unowned', null, {
                known: [...APP_CLUSTER_OP_IDS],
            });
        }

        const route = this.route(op);

        // ---- R-15, centrally -------------------------------------------------------------
        const guard = await this.deletionGuard(workId);
        if (guard.code) {
            return this.refuse(payload, guard.code, route, null, guard.detail);
        }

        if (route === 'unowned') {
            const owner = APP_CLUSTER_OP_OWNERS[op] as AppClusterOpOwner | undefined;
            this.logger.warn(
                `app-cluster-op: ${op} has no handler in this tree — ${
                    owner?.path ?? 'its owner file'
                } is ${owner?.task ?? 'another task'}'s and has not landed.`,
            );

            return this.refuse(payload, APP_CLUSTER_OP_CODE_UNOWNED, route, owner?.path ?? null, {
                owner: owner?.task ?? null,
            });
        }

        const handler = this.handlerFor(route, op);
        if (!handler) {
            // The classifier says the op is served, but the service is not in this context: the
            // same refusal an unowned op gets, minus a file to wait on, plus the member's name.
            const missing = this.missingMember(op, route);
            this.logger.warn(
                `app-cluster-op: ${op} is classified as ${route}, but ${missing ?? 'its handler'} is ` +
                    'not bound in this context — nothing was routed.',
            );

            return this.refuse(payload, APP_CLUSTER_OP_CODE_UNOWNED, route, missing, {
                member: missing,
            });
        }

        try {
            const result = await handler(payload);
            const state = routerStateOf(result);
            const cache = await this.writeOp(payload, state, codeOf(result));

            return {
                op,
                workId,
                requestId,
                state,
                code: codeOf(result),
                route,
                missing: null,
                result: result ?? null,
                cache,
            };
        } catch (error) {
            const message = messageOf(error);
            this.logger.error(`app-cluster-op: the ${op} handler threw — ${message}`);
            const cache = await this.writeOp(payload, 'failed', APP_CLUSTER_OP_CODE_HANDLER_FAILED);

            return {
                op,
                workId,
                requestId,
                state: 'failed',
                code: APP_CLUSTER_OP_CODE_HANDLER_FAILED,
                route,
                missing: null,
                result: { message },
                cache,
            };
        }
    }

    /* ---------------------------------------------------------------------- *
     * The classifier's handlers, always read off the bound service
     * ---------------------------------------------------------------------- */

    private handlerFor(route: AppClusterOpRoute, op: string): AppClusterOpHandler | null {
        if (route === 'registered') {
            return this.handlers.get(op) ?? null;
        }

        if (route === 'lifecycle-ops') {
            return hasMember<AppLifecycleOpsService['handle']>(this.ops, 'handle')
                ? (payload) => this.ops.handle(payload)
                : null;
        }

        if (route === 'deletion') {
            return hasMember<AppRuntimeDeletionService['handleDeleteAppWork']>(
                this.deletion,
                'handleDeleteAppWork',
            )
                ? (payload) => this.deletion.handleDeleteAppWork(payload as never)
                : null;
        }

        if (route === 'verification') {
            const member = VERIFICATION_MEMBERS[op] ?? '';
            if (!member || !hasMember(this.verification, member)) {
                return null;
            }
            return (payload) =>
                (this.verification as unknown as Record<string, (p: unknown) => Promise<unknown>>)[
                    member
                ](payload);
        }

        return null;
    }

    /** The member name a routed op needed — reported so an operator knows what to bind. */
    private missingMember(op: string, route: AppClusterOpRoute): string | null {
        if (route === 'lifecycle-ops') {
            return 'AppLifecycleOpsService.handle';
        }
        if (route === 'deletion') {
            return 'AppRuntimeDeletionService.handleDeleteAppWork';
        }
        if (route === 'verification') {
            return `AppVerificationTargetService.${VERIFICATION_MEMBERS[op] ?? 'handleVerification*'}`;
        }
        return null;
    }

    /* ---------------------------------------------------------------------- *
     * The R-15 guard
     * ---------------------------------------------------------------------- */

    /**
     * The runtime-state row's `deletionRequestedAt`, read once per routed op.
     *
     * Three answers, and the third is deliberately **not** an assumption: no store is bound at all
     * (T17 has not landed — the same state `app-lifecycle-ops.service.ts` names
     * `runtime_state_unavailable` for its own handlers), a row that cannot be read
     * (`runtime_state_unreadable` — the truth is unknown, so nothing is dialled), or a row that
     * says a deletion is in flight (`app_work_deleting`).
     */
    private async deletionGuard(workId: string): Promise<{
        code: string | null;
        detail: Record<string, unknown> | null;
    }> {
        if (!hasMember<AppLifecycleOpStateStore['getOrCreate']>(this.states, 'getOrCreate')) {
            // No row can be read, so the guard cannot be made. The handlers that need the row refuse
            // on their own (`runtime_state_unavailable`); the ones that do not (a log tail) proceed,
            // and this is the only case in which the R-15 check is skipped — which is why it is
            // reported in the result's `detail` by the handler that ran.
            return { code: null, detail: null };
        }

        try {
            const state = await this.states.getOrCreate(workId);
            if (state?.deletionRequestedAt) {
                return {
                    code: APP_CLUSTER_OP_CODE_APP_WORK_DELETING,
                    detail: { deletionRequestedAt: String(state.deletionRequestedAt) },
                };
            }
            return { code: null, detail: null };
        } catch (error) {
            return {
                code: APP_CLUSTER_OP_CODE_RUNTIME_STATE_UNREADABLE,
                detail: { message: messageOf(error) },
            };
        }
    }

    /* ---------------------------------------------------------------------- *
     * The cache entry a refusal still writes
     * ---------------------------------------------------------------------- */

    private async writeOp(
        payload: AppClusterOpPayload,
        state: AppClusterOpRouterResult['state'],
        code: string | null,
    ): Promise<'written' | 'unbound' | 'failed' | 'skipped'> {
        const workId = text(payload?.workId);
        const requestId = text(payload?.requestId);
        const op = text(payload?.op);

        // `logs` writes `app-logs:` itself and nothing to `app-op:` (§9.10:1587), and an op with no
        // request id has no key a reader could name.
        if (!workId || !requestId || op === 'logs') {
            return 'skipped';
        }
        if (!this.cache || typeof this.cache.set !== 'function') {
            return 'unbound';
        }

        try {
            await this.cache.set(
                appOpCacheKey(workId, requestId),
                {
                    op,
                    state: state === 'done' ? 'done' : state === 'deferred' ? 'running' : 'failed',
                    ...(code ? { code } : {}),
                },
                APP_OP_CACHE_TTL_MS,
            );
            return 'written';
        } catch (error) {
            this.logger.warn(
                `The app-op entry for ${workId}/${requestId} could not be cached: ${messageOf(error)}`,
            );
            return 'failed';
        }
    }

    private async refuse(
        payload: AppClusterOpPayload,
        code: string,
        route: AppClusterOpRoute,
        missing: string | null,
        detail: Record<string, unknown> | null,
    ): Promise<AppClusterOpRouterResult> {
        const cache = await this.writeOp(payload, 'refused', code);

        return {
            op: text(payload?.op),
            workId: text(payload?.workId),
            requestId: text(payload?.requestId) || null,
            state: 'refused',
            code,
            route,
            missing,
            result: { detail },
            cache,
        };
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

/**
 * The state of a handler's answer.
 *
 * A handler that answers a `state` is read verbatim; anything else (T58's `AppWorkDeletionOpResult`,
 * T60's `AppVerificationResult`) is `done` — those services report their own outcome inside their
 * result and never refuse by throwing, which is exactly why their owner tasks call them directly.
 */
export function routerStateOf(result: unknown): AppClusterOpRouterResult['state'] {
    const state = text((result as { state?: unknown } | null)?.state);
    if (state === 'done' || state === 'failed' || state === 'refused' || state === 'deferred') {
        return state;
    }
    return 'done';
}

/** The code a handler's answer carries, when it carries one. */
export function codeOf(result: unknown): string | null {
    return text((result as { code?: unknown } | null)?.code) || null;
}
