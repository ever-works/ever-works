import { normalizeApiUrl } from './fleet-client';
import type { NodeConfig } from './types';

/**
 * Where the node points its control plane — and how an operator moves it
 * WITHOUT editing the credential file (EW-779, self-build finding OPS-21).
 *
 * The problem this exists for. The fleet builds the platform that dispatches
 * the fleet. Until now the only API origin a node would ever use was the one
 * baked into `node-config.json` at enrollment: `--api-url` is a
 * `requiredOption` on `enroll` alone and is never re-settable afterwards. So a
 * broken `develop` could orphan every machine at once, and the only way to
 * move them was to hand-edit a 0600 / ACL-locked file that also holds the
 * heartbeat secret — on six machines, at whatever hour it happened.
 *
 * The pin is therefore an ENVIRONMENT variable, in the same family as the
 * node's other operator overrides (`EVER_WORKS_NODE_CONFIG`,
 * `EVER_WORKS_NODE_BROWSER`, `EVER_WORKS_NODE_DISABLE_KEYCHAIN`): set it in
 * the service unit, restart, done — and unset it to go back, because a pin
 * that cannot be reversed by removing it is a second way to strand the fleet.
 *
 * Three deliberate non-behaviours:
 *
 *   - It is NEVER written back through `saveConfig`. The enrolled origin is
 *     the origin the secret was minted against and must survive the pin.
 *   - It does NOT apply to `enroll` (see `enrollNode`). Enrollment mints a
 *     credential against a specific platform; silently pinning it elsewhere
 *     would mint the credential on one platform and store it as belonging to
 *     another.
 *   - An empty or whitespace-only value is treated as ABSENT, never as "no
 *     API". `FOO=` in a unit file is how an operator disables an override,
 *     and it must not brick the node.
 *
 * A pin that points at a platform this node did not enrol against will 401 on
 * every call, and `heartbeat.ts` makes `unauthorized` sticky — so the mismatch
 * is surfaced loudly by `status` and `doctor` rather than being left to be
 * diagnosed from a retry loop.
 */

/** Operator override for the control-plane origin. Absent means "use the enrolled one". */
export const API_URL_ENV = 'EVER_WORKS_NODE_API_URL';

/**
 * The two origins Ever Works publishes. Named here so the runbook and the
 * `--help` text cannot drift from each other; nothing enforces that a pin is
 * one of these.
 */
export const KNOWN_STABLE_API_BASES = ['https://apistage.ever.works', 'https://api.ever.works'] as const;

export interface ResolvedApiBase {
	/** The origin every runtime call should use. */
	url: string;
	/** Where {@link ResolvedApiBase.url} came from. Names a source, never a value. */
	source: 'pin' | 'config';
	/** The origin recorded at enrollment — what the node's secret was minted against. */
	configuredUrl: string;
	/** The operator's pin, canonicalized, or null when none is set. */
	pinnedTo: string | null;
	/**
	 * True when a pin is set and points somewhere OTHER than the enrolled
	 * origin. That combination authenticates against a platform that has never
	 * seen this node, so every call 401s — worth saying out loud.
	 */
	mismatch: boolean;
}

/** Read the raw pin, treating absent, empty and whitespace-only alike. */
function rawPin(env: Record<string, string | undefined>): string | null {
	const value = env[API_URL_ENV];
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

/**
 * The pin on its own, for surfaces that run before (or without) an enrollment
 * — `doctor` on a machine that has not enrolled yet.
 *
 * Throws the same `FleetClientError('invalid-request')` a malformed
 * `--api-url` throws, at STARTUP rather than at the first request: a pin with
 * a typo should stop the node with a URL error, not turn into a mystifying
 * 403/404 twenty minutes later.
 */
export function readApiUrlPin(env: Record<string, string | undefined> = process.env): string | null {
	const raw = rawPin(env);
	return raw === null ? null : normalizeApiUrl(raw);
}

/**
 * Resolve the control-plane origin for an enrolled node: the operator's pin
 * when one is set, otherwise the origin recorded at enrollment.
 *
 * `env` is a parameter (defaulting to `process.env`) rather than a direct read
 * because `apps/desktop-node` shares this core through `createNodeRuntime` —
 * both shells, and every test, have to be able to supply their own.
 */
export function resolveApiBase(
	config: Pick<NodeConfig, 'apiUrl'>,
	env: Record<string, string | undefined> = process.env
): ResolvedApiBase {
	const configuredUrl = config.apiUrl;
	const pinnedTo = readApiUrlPin(env);
	if (pinnedTo === null) {
		return { url: configuredUrl, source: 'config', configuredUrl, pinnedTo: null, mismatch: false };
	}
	return {
		url: pinnedTo,
		source: 'pin',
		configuredUrl,
		pinnedTo,
		mismatch: pinnedTo !== configuredUrl
	};
}

/**
 * One line for `status` / `doctor` / the startup log. Separate from the
 * resolver so every surface says the same thing about the same state.
 */
export function describeApiBase(base: ResolvedApiBase): string {
	if (base.source === 'config') {
		return `${base.url} (from the enrolled config)`;
	}
	if (!base.mismatch) {
		return `${base.url} (pinned via ${API_URL_ENV}; matches the enrolled origin)`;
	}
	return (
		`${base.url} (PINNED via ${API_URL_ENV}) — enrolled against ${base.configuredUrl}. ` +
		'The pin does not match the enrolled origin: this node has no credential on the pinned platform, ' +
		'so every call will be refused with 401 until the pin is corrected or the node is re-enrolled.'
	);
}
