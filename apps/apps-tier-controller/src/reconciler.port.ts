/**
 * The seam every reconciler implements, and the registry the bootstrap starts.
 *
 * There is exactly one of these interfaces so that the five planned reconcilers (APW-10 T6 `Work`,
 * T7 quarantine, T9 `SelfCheck`, T39 removal, T43 dependencies) are startable, stoppable and
 * observable the same way — and so the bootstrap can refuse to run a registry that claims to watch
 * a kind the CRDs do not define, which is the failure mode of every hand-rolled operator.
 */
import { CRD_MANIFESTS } from '@ever-works/apps-tier-crds';

import type { ControllerConfig } from './config.js';

/** Every `kind` the installed CRDs define — derived, never re-listed. */
export const WATCHABLE_KINDS: readonly string[] = CRD_MANIFESTS.map((manifest) => manifest.spec.names.kind);

/** The minimum a reconciler may log with. Deliberately not `console` so a spec can capture it. */
export interface ReconcilerLogger {
	info(message: string, fields?: Readonly<Record<string, unknown>>): void;
	warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
	error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** What a reconciler is handed when it starts. */
export interface ReconcilerContext {
	readonly config: ControllerConfig;
	readonly logger: ReconcilerLogger;
	/** Resolves when the process is shutting down; a watch loop must stop on it. */
	readonly shutdown: AbortSignal;
}

/**
 * One control loop over one CRD kind.
 *
 * `start` must return once its watch is established — it is not the loop itself — and must not
 * throw for a transient API error; the loop owns its own backoff. `stop` must be idempotent.
 */
export interface Reconciler {
	/** Stable identifier, used in logs and in the zone-info ConfigMap. */
	readonly name: string;
	/** The CRD `kind` this loop watches; must be one of {@link WATCHABLE_KINDS}. */
	readonly watches: string;
	start(context: ReconcilerContext): Promise<void>;
	stop(): Promise<void>;
}

/** Why a registry was rejected before anything started watching. */
export interface RegistryRefusal {
	readonly code: 'NO_RECONCILERS_REGISTERED' | 'UNKNOWN_WATCHED_KIND' | 'DUPLICATE_RECONCILER_NAME';
	readonly message: string;
}

/**
 * Check a registry before starting it.
 *
 * An empty registry is a refusal rather than a no-op: a controller Pod that reports healthy while
 * reconciling nothing is the single most dangerous state this component can be in — the platform
 * would go on writing `Work` objects and reading a `status` that never arrives, and every tenant
 * would sit in `Pending` while the zone looked fine.
 */
export function validateRegistry(reconcilers: readonly Reconciler[]): readonly RegistryRefusal[] {
	const refusals: RegistryRefusal[] = [];

	if (reconcilers.length === 0) {
		refusals.push({
			code: 'NO_RECONCILERS_REGISTERED',
			message:
				'No reconcilers are registered, so this process would watch nothing while reporting healthy. Register at least one (APW-10 T6) before starting the controller.'
		});
	}

	const seen = new Set<string>();
	for (const reconciler of reconcilers) {
		if (seen.has(reconciler.name)) {
			refusals.push({
				code: 'DUPLICATE_RECONCILER_NAME',
				message: `Two reconcilers are named "${reconciler.name}"; names appear in the zone-info ConfigMap and must be unique.`
			});
		}
		seen.add(reconciler.name);

		if (!WATCHABLE_KINDS.includes(reconciler.watches)) {
			refusals.push({
				code: 'UNKNOWN_WATCHED_KIND',
				message: `Reconciler "${reconciler.name}" watches kind "${reconciler.watches}", which no installed CRD defines. Known kinds: ${WATCHABLE_KINDS.join(', ')}.`
			});
		}
	}

	return refusals;
}
