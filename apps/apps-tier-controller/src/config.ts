/**
 * The controller's startup contract: what it reads from the environment, and every reason it
 * refuses to run.
 *
 * **It fails closed on purpose.** This process is the only thing standing between one customer's
 * forked, unreviewed application and every other tenant in the zone. A controller that starts with
 * a half-known configuration — no zone identity, an unspecified control namespace, a version the
 * platform does not trust — would reconcile objects it cannot correctly scope. So the loader
 * returns *refusals*, never defaults-with-a-warning, for anything that decides blast radius.
 *
 * It is also a pure function of an `env` object rather than a reader of `process.env`, so a spec
 * can exercise every refusal without touching the real environment.
 */
import {
	APPS_TIER_API_GROUP,
	APPS_TIER_API_VERSION,
	APPS_TIER_CONTROLLER_MIN_VERSION_ENV_VAR,
	APPS_TIER_CONTROL_KUBECONFIG_ENV_VAR,
	APPS_TIER_CONTROL_NAMESPACE_DEFAULT,
	APPS_TIER_MANAGED_ENABLED_ENV_VAR,
	APPS_TIER_TENANT_NAMESPACE_PREFIX
} from '@ever-works/contracts';

/**
 * This build's version. Kept equal to `package.json` by `__tests__/config.spec.ts` — the platform
 * compares it against {@link APPS_TIER_CONTROLLER_MIN_VERSION_ENV_VAR} before it trusts a zone, so
 * a version that drifts from the artefact would let an old controller claim to be a new one.
 */
export const CONTROLLER_VERSION = '0.1.0';

/** The env var naming the zone this controller is responsible for. */
export const ZONE_ID_ENV_VAR = 'EVER_WORKS_APPS_ZONE_ID' as const;

/** The env var overriding the control namespace (default {@link APPS_TIER_CONTROL_NAMESPACE_DEFAULT}). */
export const CONTROL_NAMESPACE_ENV_VAR = 'EVER_WORKS_APPS_CONTROL_NAMESPACE' as const;

/** A zone id is a DNS label: the tenant namespaces and the zone's own objects are named from it. */
const ZONE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** A Kubernetes namespace name. */
const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Where the controller gets its cluster credentials. */
export type ClusterCredentialSource =
	/** The default in a Pod: the projected service-account token. */
	| { readonly kind: 'in-cluster' }
	/** A kubeconfig path, for local development against a kind cluster. */
	| { readonly kind: 'kubeconfig'; readonly path: string };

/** Everything the controller needs to know before it may watch anything. */
export interface ControllerConfig {
	/** The zone this controller owns. Every object it reconciles must belong to it. */
	readonly zoneId: string;
	/** The namespace holding the `Work`, `AppBuild`, `SelfCheck`, `UsageReport` and `AbuseSignal` objects. */
	readonly controlNamespace: string;
	/** The prefix every tenant namespace carries — `ewa-<workId>`. */
	readonly tenantNamespacePrefix: typeof APPS_TIER_TENANT_NAMESPACE_PREFIX;
	/** `hosting.ever.works/v1alpha1`. */
	readonly apiVersion: `${typeof APPS_TIER_API_GROUP}/${typeof APPS_TIER_API_VERSION}`;
	/** How this process authenticates to the cluster. */
	readonly credentials: ClusterCredentialSource;
	/** This build's version, for the zone-info ConfigMap and the platform's minimum-version gate. */
	readonly version: string;
}

/** A refusal to start: a machine code and a sentence an operator can act on. */
export interface ControllerRefusal {
	readonly code:
		| 'MANAGED_TIER_NOT_ENABLED'
		| 'ZONE_ID_MISSING'
		| 'ZONE_ID_MALFORMED'
		| 'CONTROL_NAMESPACE_MALFORMED'
		| 'CONTROLLER_VERSION_BELOW_PLATFORM_MINIMUM';
	readonly message: string;
}

/** Either a complete configuration, or every reason it is not one. */
export type ControllerConfigResult =
	| { readonly ok: true; readonly config: ControllerConfig }
	| { readonly ok: false; readonly refusals: readonly ControllerRefusal[] };

/** `a.b.c` → `[a, b, c]`, or `null` when it is not a three-part numeric version. */
function parseSemver(value: string): readonly [number, number, number] | null {
	const parts = value.trim().split('.');
	if (parts.length !== 3) return null;
	const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
	if (numbers.some(Number.isNaN)) return null;
	return [numbers[0] as number, numbers[1] as number, numbers[2] as number];
}

/** `true` when `version` is at least `minimum`. Unparseable input is NOT treated as satisfied. */
export function satisfiesMinimumVersion(version: string, minimum: string): boolean {
	const have = parseSemver(version);
	const need = parseSemver(minimum);
	if (have === null || need === null) return false;
	for (let index = 0; index < 3; index += 1) {
		const mine = have[index] as number;
		const theirs = need[index] as number;
		if (mine > theirs) return true;
		if (mine < theirs) return false;
	}
	return true;
}

/**
 * Read the controller's configuration from `env`, collecting **every** refusal rather than
 * throwing on the first — an operator fixing a Deployment wants the whole list in one restart.
 */
export function loadControllerConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfigResult {
	const refusals: ControllerRefusal[] = [];

	// The managed tier is opt-in, everywhere, always. An unset flag is a refusal and not a default,
	// because the one thing worse than a zone that will not start is a zone that starts by accident.
	if (env[APPS_TIER_MANAGED_ENABLED_ENV_VAR] !== '1') {
		refusals.push({
			code: 'MANAGED_TIER_NOT_ENABLED',
			message: `${APPS_TIER_MANAGED_ENABLED_ENV_VAR} must be exactly "1" to run the hosting-tier controller.`
		});
	}

	const rawZoneId = env[ZONE_ID_ENV_VAR]?.trim() ?? '';
	if (rawZoneId === '') {
		refusals.push({
			code: 'ZONE_ID_MISSING',
			message: `${ZONE_ID_ENV_VAR} is required: the controller must know which zone's objects are its own.`
		});
	} else if (!ZONE_ID_PATTERN.test(rawZoneId)) {
		refusals.push({
			code: 'ZONE_ID_MALFORMED',
			message: `${ZONE_ID_ENV_VAR}="${rawZoneId}" is not a DNS label (lower-case alphanumerics and hyphens, 1–32 chars).`
		});
	}

	const rawNamespace = env[CONTROL_NAMESPACE_ENV_VAR]?.trim();
	const controlNamespace =
		rawNamespace === undefined || rawNamespace === '' ? APPS_TIER_CONTROL_NAMESPACE_DEFAULT : rawNamespace;
	if (!NAMESPACE_PATTERN.test(controlNamespace)) {
		refusals.push({
			code: 'CONTROL_NAMESPACE_MALFORMED',
			message: `${CONTROL_NAMESPACE_ENV_VAR}="${controlNamespace}" is not a valid namespace name.`
		});
	}

	const minimumVersion = env[APPS_TIER_CONTROLLER_MIN_VERSION_ENV_VAR]?.trim();
	if (
		minimumVersion !== undefined &&
		minimumVersion !== '' &&
		!satisfiesMinimumVersion(CONTROLLER_VERSION, minimumVersion)
	) {
		refusals.push({
			code: 'CONTROLLER_VERSION_BELOW_PLATFORM_MINIMUM',
			message: `This controller is ${CONTROLLER_VERSION}; the platform requires at least ${minimumVersion} (${APPS_TIER_CONTROLLER_MIN_VERSION_ENV_VAR}).`
		});
	}

	if (refusals.length > 0) return { ok: false, refusals };

	const kubeconfigPath = env[APPS_TIER_CONTROL_KUBECONFIG_ENV_VAR]?.trim();
	const credentials: ClusterCredentialSource =
		kubeconfigPath === undefined || kubeconfigPath === ''
			? { kind: 'in-cluster' }
			: { kind: 'kubeconfig', path: kubeconfigPath };

	return {
		ok: true,
		config: {
			zoneId: rawZoneId,
			controlNamespace,
			tenantNamespacePrefix: APPS_TIER_TENANT_NAMESPACE_PREFIX,
			apiVersion: `${APPS_TIER_API_GROUP}/${APPS_TIER_API_VERSION}`,
			credentials,
			version: CONTROLLER_VERSION
		}
	};
}
