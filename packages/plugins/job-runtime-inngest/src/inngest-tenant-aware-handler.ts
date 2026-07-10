import type { IJobRuntimeProvider, TenantCredentialSnapshot } from '@ever-works/plugin';
import type { InngestJobRuntimePlugin } from './inngest-job-runtime.plugin.js';
import type { InngestSendEvent } from './inngest-types.js';

/**
 * EW-742 P4 T26/T30/T32 — tenant-aware Inngest function handler wrapper.
 *
 * Sibling of `TenantAwareBullMqWorkerHostFactory` /
 * `TenantAwarePgBossWorkerHostFactory` for Inngest — but because Inngest
 * has **no worker host process** (operator-defined functions are invoked
 * over HTTP via `serve()`), this module exposes a higher-order function
 * (HOF) that wraps the operator's per-function handler rather than a
 * factory that starts long-lived workers.
 *
 * # Why a wrapper, not a factory
 *
 * Inngest's dispatch model is push: the platform invokes the operator's
 * HTTP `serve()` mount when an event matches a registered function. The
 * "worker" is just the route handler. So tenant routing has to happen
 * inside each function's `handler({ event, step })` body — wrap once,
 * register the wrapped handler with `factory.defineFunction(...)`, and
 * each invocation gets the right tenant binding injected as the second
 * arg.
 *
 * # Tenant carrier
 *
 * Per T31 `mapEnqueueOptions`, `tenantId` is stamped on
 * `event.data._ew.tenantId` (Inngest has no native carrier — we use a
 * reserved `_ew` namespace on `event.data`). The wrapper reads it from
 * there, resolves the snapshot via the optional
 * {@link TenantAwareInngestWrapperOptions.resolveSnapshot} callback (or a
 * synthetic empty-credentials snapshot for inherit-mode tenants + unit
 * tests), and calls `plugin.bindToTenant(snapshot)`.
 *
 * # Memoisation
 *
 * The wrapper does NOT cache snapshots or bindings itself — both layers
 * already memoise:
 *   - `plugin.bindToTenant` memoises views by `(tenantId, credentialVersion)`.
 *   - The operator's `resolveSnapshot` is expected to memoise too (the
 *     real impl reads from a secrets-store cache with TTL invalidation).
 *
 * Concurrent invocations for the same tenant therefore share the same
 * binding without this wrapper adding another cache layer.
 *
 * # FR-5 fallback
 *
 * Events without `data._ew.tenantId` (instance-default routing — the
 * EW-683 pre-tenancy path) get the plugin singleton itself as the
 * binding, byte-identical to a non-tenant-aware handler.
 */

export interface InngestFunctionContext {
	readonly event: InngestSendEvent;
	readonly step?: unknown;
	readonly runId?: string;
	readonly attempt?: number;
}

/**
 * Handler signature for tenant-aware Inngest functions — the second arg
 * is the `IJobRuntimeProvider` view bound to the event's tenant (or the
 * plugin itself for tenant-less events per FR-5).
 */
export type TenantAwareInngestHandler<T = unknown> = (
	ctx: InngestFunctionContext,
	binding: IJobRuntimeProvider
) => Promise<T>;

export interface TenantAwareInngestWrapperOptions {
	readonly plugin: InngestJobRuntimePlugin;
	/**
	 * Optional resolver that turns a tenantId into a full
	 * {@link TenantCredentialSnapshot}. Falls back to a synthetic
	 * `{ tenantId, providerId: 'inngest', credentialVersion: 1, credentials: {} }`
	 * when omitted — sufficient for unit tests + inherit-mode tenants
	 * where no real credential bag is stored.
	 */
	readonly resolveSnapshot?: (tenantId: string) => TenantCredentialSnapshot | Promise<TenantCredentialSnapshot>;
}

function extractTenantId(ctx: InngestFunctionContext): string | undefined {
	const data = ctx.event?.data as Record<string, unknown> | undefined;
	if (!data || typeof data !== 'object') {
		return undefined;
	}
	const ew = (data as { _ew?: { tenantId?: unknown } })._ew;
	if (ew && typeof ew.tenantId === 'string' && ew.tenantId.length > 0) {
		return ew.tenantId;
	}
	return undefined;
}

function syntheticSnapshot(tenantId: string): TenantCredentialSnapshot {
	return {
		tenantId,
		providerId: 'inngest',
		credentialVersion: 1,
		credentials: {}
	};
}

/**
 * Returns a higher-order function:
 *   `(operatorHandler) => (ctx) => operatorHandler(ctx, binding)`.
 *
 * On each invocation the wrapper:
 *   1. Extracts `tenantId` from `ctx.event.data._ew.tenantId`.
 *   2. Resolves the snapshot via `resolveSnapshot(tenantId)` (or
 *      synthesises an empty-credential snapshot when no resolver was
 *      supplied — useful for inherit-mode tenants and unit tests).
 *   3. Calls `plugin.bindToTenant(snapshot)` and forwards the returned
 *      `IJobRuntimeProvider` view to the operator handler as `binding`.
 *   4. For events without a tenantId, hands the plugin itself to the
 *      handler (FR-5 fallback — instance-default routing).
 *
 * The wrapper preserves the handler's return value and propagates errors
 * unchanged.
 */
export function tenantAwareInngestFunctionHandler(
	opts: TenantAwareInngestWrapperOptions
): <T>(handler: TenantAwareInngestHandler<T>) => (ctx: InngestFunctionContext) => Promise<T> {
	const { plugin, resolveSnapshot } = opts;
	return <T>(handler: TenantAwareInngestHandler<T>) =>
		async (ctx: InngestFunctionContext): Promise<T> => {
			const tenantId = extractTenantId(ctx);
			let binding: IJobRuntimeProvider;
			if (!tenantId) {
				binding = plugin;
			} else {
				const snapshot = resolveSnapshot ? await resolveSnapshot(tenantId) : syntheticSnapshot(tenantId);
				const bound = plugin.bindToTenant(snapshot);
				binding = bound ?? plugin;
			}
			return handler(ctx, binding);
		};
}
