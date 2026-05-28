import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { ScopeContext, EMPTY_SCOPE } from './scope-context.types';

/**
 * Mutable holder stored in the `AsyncLocalStorage`. We store a holder
 * (`{ current }`) rather than the `ScopeContext` directly so that a
 * guard running LATER in the same async context (after `request.user`
 * is populated) can re-seed the scope in place via `setScope` — the
 * `runWith` frame is already on the stack and we can't restart it from
 * a guard. See [`SessionScopeGuard`](./session-scope.guard.ts).
 */
interface ScopeHolder {
    current: ScopeContext;
}

/**
 * EW-657 (Tenants & Organizations Phase 5b) — request-scoped
 * propagation of `{ tenantId, organizationId }` via `AsyncLocalStorage`.
 *
 * **Why AsyncLocalStorage and not a NestJS `Scope.REQUEST` provider?**
 * Request-scoped DI providers force every consumer (and every consumer
 * of those consumers) to also become request-scoped, which silently
 * bubbles through the whole graph and tanks per-request overhead.
 * `ScopeContext` is read from many places (every service that touches
 * a Tier C entity, plus the TypeORM subscriber that auto-stamps Tier C
 * inserts) — making all of those request-scoped would be a real
 * performance regression.
 *
 * Instead, this service is a singleton wrapping a single
 * `AsyncLocalStorage<ScopeContext>` instance. Scope is set once per
 * request by [`ScopeContextMiddleware`](./scope-context.middleware.ts)
 * (today: from `request.user.tenantId` and
 * `request.user.lastScopeOrganizationId`; Phase 7 will override with
 * the slug-resolved scope). Background jobs that need to set a scope
 * for an awaited block call `runWith(scope, async () => { ... })`.
 *
 * **Outside any `runWith` boundary, `getScope()` returns `EMPTY_SCOPE`
 * (both fields `null`).** That's the right answer for unauthenticated
 * requests and for boot-time code that runs before any HTTP request.
 *
 * The [`ScopeStampingSubscriber`](./scope-stamping.subscriber.ts)
 * reads from this service in TypeORM's `beforeInsert` hook to stamp
 * Tier C entities — so a service that *doesn't* explicitly thread
 * `ScopeContext` through its create paths still gets the right scope
 * by default. Explicit injection is preferred (clearer data flow); the
 * subscriber is the safety net.
 */
@Injectable()
export class ScopeContextService {
    private readonly logger = new Logger(ScopeContextService.name);
    private readonly storage = new AsyncLocalStorage<ScopeHolder>();

    /**
     * Returns the active scope, or `EMPTY_SCOPE` (both fields `null`)
     * if called outside a `runWith` boundary.
     */
    getScope(): ScopeContext {
        return this.storage.getStore()?.current ?? EMPTY_SCOPE;
    }

    getTenantId(): string | null {
        return this.getScope().tenantId;
    }

    getOrganizationId(): string | null {
        return this.getScope().organizationId;
    }

    /**
     * Run `fn` with the given scope as the active one. Nested calls
     * fully override the parent scope (no merging — explicit is better
     * than implicit here). Async work inside `fn` retains the scope
     * because that's exactly what `AsyncLocalStorage` is for.
     */
    runWith<T>(scope: ScopeContext, fn: () => T): T {
        return this.storage.run({ current: scope }, fn);
    }

    /**
     * EW-664 (Tenants & Organizations Phase 12) — re-seed the active
     * scope IN PLACE within the current `runWith` frame.
     *
     * Used by [`SessionScopeGuard`](./session-scope.guard.ts) to fall
     * back to an authenticated user's default scope (their Tenant +
     * last-active Org) on legacy un-prefixed routes, where the Phase 7
     * [`ScopeResolverMiddleware`](./scope-resolver.middleware.ts) ran
     * the request under `EMPTY_SCOPE` because no slug was present. The
     * middleware can't do this itself — it runs BEFORE `AuthSessionGuard`
     * populates `request.user`, so it has no user to read a default
     * scope from.
     *
     * Mutates the holder the middleware created via `runWith`, so every
     * later reader in the same async context (the controller, the
     * Phase 5b [`ScopeStampingSubscriber`](./scope-stamping.subscriber.ts))
     * observes the seeded scope.
     *
     * Outside any `runWith` frame (no holder in the ALS — e.g. boot-time
     * code, or a misordered guard) this is a no-op: seeding only makes
     * sense inside a request that has an active scope holder.
     */
    setScope(scope: ScopeContext): void {
        const holder = this.storage.getStore();
        if (!holder) {
            this.logger.debug('setScope() called outside a runWith frame — no-op');
            return;
        }
        holder.current = scope;
    }
}
