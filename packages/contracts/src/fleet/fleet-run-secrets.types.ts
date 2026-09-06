/**
 * Run secrets — how a fleet node gets a repository's `.env` files, and how
 * an operator opens a keyhole in the platform-owned env refusal.
 *
 * ## THE INVARIANT OF THIS MODULE
 *
 * **No shape declared here can hold a secret VALUE except
 * {@link FleetRunEnvFileContent}, which exists only as the body of the
 * node-authenticated fetch response.** The job payload, the fleet job row,
 * the workspace spec and the grant list carry NAMES and PATHS — never
 * contents. A reviewer checking that claim only has to read the field
 * lists below: `paths`, `repoConnectionId`, `mountDir`, grant names.
 *
 * ## Why by reference
 *
 * `RepoConnection.envFiles` is envelope-encrypted at rest and only ever
 * decrypted for its owner. Putting the decrypted content on a fleet job
 * would persist it in `fleet_jobs.payload`, echo it into every job view
 * the owner's dashboard renders, and hand it to any log line that dumps a
 * payload. So the payload names WHICH repository's files a run needs, and
 * the node fetches the content over the same credential-verified channel
 * it already uses for lease / heartbeat / complete, while it holds the
 * lease on that job.
 *
 * ## Why grants are names on the wire
 *
 * A grant is the operator saying "agent-driven code on my machines may
 * read THIS variable from the node's own environment". Only the name
 * travels; the value is read from `process.env` on the node and is
 * scrubbed back out of everything the node reports. That is why a grant
 * is safe to carry on a payload and an env file is not.
 */

import { FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN, isReservedMountDir } from './fleet-task-workspace.types.js';

/** Env files a single repository may deliver to one run (registry cap). */
export const FLEET_RUN_ENV_FILE_MAX_COUNT = 8;

/** Per-file content ceiling, mirroring `REPO_CONNECTION_ENV_FILE_MAX_CONTENT_BYTES`. */
export const FLEET_RUN_ENV_FILE_MAX_CONTENT_BYTES = 32 * 1024;

/** Ceiling on everything one run may receive, across every repository. */
export const FLEET_RUN_ENV_FILES_MAX_TOTAL_BYTES = 256 * 1024;

/** Repositories one run may pull env files from (primary + every mount). */
export const FLEET_RUN_ENV_FILE_REFS_MAX_COUNT = 9;

/** One traversal-free path segment of an env-file path. */
export const FLEET_RUN_ENV_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** Env names one repository may grant. Matches the node's `MAX_ENV_PASSTHROUGH`. */
export const FLEET_RUN_ENV_GRANT_MAX_COUNT = 32;

/** Shape of a grantable env var name — the node's own `NODE_ENV_NAME_PATTERN`. */
export const FLEET_RUN_ENV_GRANT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * The un-grantable CORE: namespaces no per-repository grant can ever open,
 * however explicitly an operator asks.
 *
 * `FLEET_` and `EVER_WORKS_` are the node's OWN credential namespace — a
 * grant there would let model-driven code read the secret that leases work
 * on that machine and then lease, complete or cancel jobs as the node.
 * `PLUGIN_` holds `PLUGIN_SECRET_ENCRYPTION_KEY`, which decrypts every
 * other tenant's env files. `AUTH_` / `BETTER_AUTH_` / `PLATFORM_` sign
 * and validate platform sessions. None of these is ever what an operator
 * means by "let my test suite reach the database", so refusing them costs
 * nothing and closes the escalation from "read one secret" to "become the
 * platform".
 *
 * Everything else the platform-owned pattern refuses — `DATABASE_`, `GH_`,
 * `AWS_`, `S3_`, `REDIS_`, `STRIPE_`, `SENTRY_`, `POSTHOG_` … — IS
 * grantable, one exact name at a time.
 */
export const FLEET_RUN_ENV_UNGRANTABLE_PATTERN = /^(FLEET_|EVER_WORKS_|PLUGIN_|AUTH_|BETTER_AUTH_|PLATFORM_)/i;

/** A reference named a repository/path the platform could not resolve. */
export const FLEET_RUN_SECRETS_UNRESOLVED_REASON = 'run-secrets-unresolved';

/** A stored env file could not be decrypted (bad key, tampered envelope). */
export const FLEET_RUN_SECRETS_DECRYPT_FAILED_REASON = 'run-secrets-decrypt-failed';

/** The instance kill switch (`FLEET_NODE_RUN_ENV_FILES=false`) is off. */
export const FLEET_RUN_SECRETS_DISABLED_REASON = 'run-secrets-disabled';

/** The node could not obtain the files (transport, 401, stale lease). */
export const FLEET_RUN_SECRETS_UNAVAILABLE_REASON = 'run-secrets-unavailable';

/**
 * One repository's env files, BY REFERENCE, as carried on the workspace
 * spec of a fleet job.
 *
 * `mountDir` says which checkout the files land in: absent means the
 * primary worktree, a value names a mount of the SAME spec. `paths` are
 * relative to that checkout root. There is no `content` field, and adding
 * one would defeat the whole design.
 */
export interface FleetRunEnvFileRef {
	/** Registry row the content is fetched from; the node never reads it itself. */
	readonly repoConnectionId: string;
	/** Mount the files belong to; absent means the primary worktree. */
	readonly mountDir?: string;
	/** Repository-relative paths, e.g. `apps/api/.env`. Never contents. */
	readonly paths: readonly string[];
}

/** What the node ASKS for. `mountDir` is node-local placement, so it is not sent. */
export interface FleetRunEnvFileRequestRef {
	readonly repoConnectionId: string;
	readonly paths: readonly string[];
}

/**
 * One decrypted env file, as it crosses the node-authenticated channel.
 *
 * THE ONLY value-bearing shape in this module. It exists for the duration
 * of one HTTPS response and one 0600 file write, and is never persisted,
 * logged, echoed into a result, or put on a job.
 */
export interface FleetRunEnvFileContent {
	readonly repoConnectionId: string;
	readonly path: string;
	readonly content: string;
}

/** Response body of `POST /api/fleet/jobs/:id/env-files`. */
export interface FleetJobEnvFilesResponse {
	readonly files: readonly FleetRunEnvFileContent[];
}

/** Refusal raised by the normalizers below. Never carries a secret value. */
export class FleetRunEnvFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FleetRunEnvFileError';
	}
}

/**
 * True when `path` is a repository-relative env-file path: slash-joined
 * segments, each of the registry's segment alphabet, no `.`/`..`, no
 * absolute or Windows-style prefix, and no segment that a shell or Git
 * would read as an option (`-f`).
 *
 * Deliberately the registry's rule PLUS the leading-dash refusal: the node
 * builds real filesystem paths out of these, and the registry gate is the
 * looser of the two.
 */
export function isValidFleetRunEnvFilePath(path: unknown): boolean {
	if (typeof path !== 'string' || !path || path.length > 200) return false;
	if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false;
	if (path.includes('\0')) return false;
	const segments = path.split('/');
	return segments.every(
		(segment) =>
			FLEET_RUN_ENV_FILE_PATH_PATTERN.test(segment) &&
			segment !== '.' &&
			segment !== '..' &&
			!segment.startsWith('-')
	);
}

/**
 * True when a per-repository grant is allowed to name `name` at all.
 *
 * Shape-valid, wildcard-free, and outside the un-grantable core. Note what
 * this does NOT do: it never decides whether the name is platform-owned.
 * That is the point of a grant — `DATABASE_URL` is platform-owned and
 * grantable, and the node admits it only because an operator bound that
 * exact name to a repository.
 */
export function isGrantableFleetRunEnvName(name: unknown): boolean {
	if (typeof name !== 'string') return false;
	const trimmed = name.trim();
	if (!FLEET_RUN_ENV_GRANT_NAME_PATTERN.test(trimmed)) return false;
	// The shape pattern already excludes `*`; the explicit check is here so
	// a future widening of the pattern cannot quietly introduce wildcards.
	if (trimmed.includes('*') || trimmed.includes('?')) return false;
	return !FLEET_RUN_ENV_UNGRANTABLE_PATTERN.test(trimmed);
}

/**
 * Validate the `envFilesRef` of a workspace spec.
 *
 * REFUSES rather than coerces, exactly like
 * `normalizeFleetTaskWorkspaceMounts`: a reference the node cannot honour
 * as written must fail naming the field, because a silently dropped env
 * file is a run that starts with a partial environment — the one outcome
 * this whole feature exists to prevent.
 *
 * `undefined`, `null` and `[]` all mean "this run needs no env files".
 */
export function normalizeFleetRunEnvFileRefs(raw: unknown): FleetRunEnvFileRef[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new FleetRunEnvFileError('workspace.envFilesRef must be an array');
	}
	if (raw.length > FLEET_RUN_ENV_FILE_REFS_MAX_COUNT) {
		throw new FleetRunEnvFileError(
			`workspace.envFilesRef has ${raw.length} entries; the limit is ${FLEET_RUN_ENV_FILE_REFS_MAX_COUNT}`
		);
	}
	const seenTargets = new Set<string>();
	return raw.map((entry, index) => {
		const at = `workspace.envFilesRef[${index}]`;
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new FleetRunEnvFileError(`${at} must be an object`);
		}
		const ref = entry as Record<string, unknown>;
		const repoConnectionId = typeof ref.repoConnectionId === 'string' ? ref.repoConnectionId.trim() : '';
		if (!repoConnectionId || repoConnectionId.length > 64 || !/^[A-Za-z0-9._-]+$/.test(repoConnectionId)) {
			throw new FleetRunEnvFileError(`${at}.repoConnectionId is not a valid registry row id`);
		}
		let mountDir: string | undefined;
		if (ref.mountDir !== undefined && ref.mountDir !== null) {
			const value = typeof ref.mountDir === 'string' ? ref.mountDir.trim() : '';
			if (!FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN.test(value) || isReservedMountDir(value)) {
				throw new FleetRunEnvFileError(`${at}.mountDir must be a mount directory of this workspace`);
			}
			mountDir = value;
		}
		// One entry per CHECKOUT: two refs for the same target would make
		// "which repository's `.env` won" depend on array order.
		const targetKey = (mountDir ?? '').toLowerCase();
		if (seenTargets.has(targetKey)) {
			throw new FleetRunEnvFileError(
				`${at} targets ${mountDir ? `mount '${mountDir}'` : 'the primary worktree'}, which another entry already claims`
			);
		}
		seenTargets.add(targetKey);
		if (!Array.isArray(ref.paths) || ref.paths.length === 0) {
			throw new FleetRunEnvFileError(`${at}.paths must be a non-empty array of repository-relative paths`);
		}
		if (ref.paths.length > FLEET_RUN_ENV_FILE_MAX_COUNT) {
			throw new FleetRunEnvFileError(
				`${at}.paths has ${ref.paths.length} entries; the limit is ${FLEET_RUN_ENV_FILE_MAX_COUNT}`
			);
		}
		const paths: string[] = [];
		const seenPaths = new Set<string>();
		for (const candidate of ref.paths) {
			if (!isValidFleetRunEnvFilePath(candidate)) {
				// The PATH is echoed (it is not a secret and the operator needs
				// to know which entry is wrong); the content never is.
				throw new FleetRunEnvFileError(
					`${at}.paths contains '${String(candidate)}', which is not a repository-relative env file path`
				);
			}
			const path = (candidate as string).trim();
			const key = path.toLowerCase();
			if (seenPaths.has(key)) {
				throw new FleetRunEnvFileError(`${at}.paths lists '${path}' twice`);
			}
			seenPaths.add(key);
			paths.push(path);
		}
		return {
			repoConnectionId,
			...(mountDir === undefined ? {} : { mountDir }),
			paths
		};
	});
}

/**
 * Shape-valid, wildcard-free, de-duplicated, capped grant names.
 *
 * Unlike {@link normalizeFleetRunEnvFileRefs} this one DROPS what it
 * cannot accept rather than throwing, because it runs on both sides: the
 * API validates an operator's edit loudly (see `assertValidEnvGrants` in
 * the registry service), while the node re-normalizes whatever arrived
 * and must never fail a run over a name it is going to ignore anyway.
 */
export function normalizeFleetRunEnvGrants(names: unknown): string[] {
	if (!Array.isArray(names)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of names) {
		if (!isGrantableFleetRunEnvName(raw)) continue;
		const name = (raw as string).trim();
		const upper = name.toUpperCase();
		if (seen.has(upper)) continue;
		seen.add(upper);
		out.push(name);
		if (out.length >= FLEET_RUN_ENV_GRANT_MAX_COUNT) break;
	}
	return out;
}
