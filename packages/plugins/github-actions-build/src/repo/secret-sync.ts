import {
	APP_BUILD_MAX_VALUES,
	APP_BUILD_SECRET_MAX_BYTES,
	APP_BUILD_SECRET_PREFIX,
	APP_BUILD_VERIFY_PROMPTED_SECRET,
	computeBuildInputsHash,
	type AppBuildBlockedReason
} from '@ever-works/contracts';
import type { BuildValue } from '@ever-works/plugin';
import { createRequire } from 'node:module';
import type sodiumType from 'libsodium-wrappers';

/**
 * APW-05 T10 — build values in, sealed repository secrets out (plan §4.7, §4.10).
 *
 * ## What this file is, and what it is not
 *
 * It is the **only** place a build value becomes a repository secret, and the only
 * place one is deleted. It is not a store: the value lives in the caller's memory,
 * inside one sealed box, and in the `PUT` body — never in a return value, never in
 * a log line, never in a thrown message. The three refusals below name things and
 * counts, never values, because a refusal travels into `blockedReason` detail,
 * Activity rows and telemetry (plan §9.1: "counters and identifiers only").
 *
 * ## The seals, and the sequence that must not drift
 *
 * `setActionSecret` in the github plugin
 * (`packages/plugins/github/src/github-actions.service.ts:49-76`) is the pattern:
 * validate the name, `await _sodium.ready`, `from_base64` the repository public
 * key, `from_string` the value, `crypto_box_seal`, `to_base64`, `PUT` with
 * `key_id`. This file repeats it exactly — the public key is fetched **once** for
 * the whole batch, and every value is sealed with that one key before any `PUT`.
 *
 * The name rule is the same one the github plugin applies
 * (`/^[A-Z_][A-Z0-9_]{0,254}$/`, never `GITHUB_`): GitHub itself rejects anything
 * else, and a name that reaches GitHub is a name that already left the process.
 * An invalid `EW_<NAME>` cannot come from APW-07's resolver (`^[A-Z_][A-Z0-9_]{0,127}$`
 * env names), so it throws rather than blocking a Build — a programming error, not
 * a user's mistake.
 *
 * ## The four refusals (plan §4.7:914–917, §4.10:1030–1033)
 *
 * | Condition                                                  | `blocked.reason`        | detail            |
 * | ---------------------------------------------------------- | ----------------------- | ----------------- |
 * | more than {@link APP_BUILD_MAX_VALUES} values               | `tooManyBuildValues`    | `{ count, max }`  |
 * | a value over {@link APP_BUILD_SECRET_MAX_BYTES} bytes       | `buildValueTooLarge`    | `{ name }` only   |
 * | an env name mapping onto `EW_VERIFY__PROMPTED`              | `buildValueNameReserved`| `{ name }`        |
 * | GitHub answers the repository secret limit                  | `secretLimitReached`    | `{}`              |
 *
 * ## Removal is set arithmetic, and it is deliberately narrow
 *
 * The delete set is exactly `previouslyWrittenSecretNames` **minus** the names
 * this call wrote. A name that was never written by the platform is never deleted,
 * whatever it looks like — including one that starts with `EW_`, which is how an
 * owner's own repository secret survives a preparation (FR-18).
 *
 * A DELETE that GitHub answers with 404 counts as removed: the name is already
 * gone (an owner deleted it by hand, or an earlier preparation deleted it and
 * failed before its row was written), and FR-18 is unaffected because the delete
 * set is still only names the platform wrote. Throwing instead would leave the
 * name on the row and fail every later preparation on the same 404, forever. A
 * 404 from the public-key fetch or a `PUT` is NOT tolerated — there it means the
 * repository itself is gone or not visible.
 */

/** The three repository-secret operations this sync needs, and nothing else (a fake is four lines). */
export interface RepositorySecretPort {
	/** The repository's Actions public key — fetched once per operation (plan §4.7:916). */
	getRepoPublicKey(): Promise<{ readonly key_id: string; readonly key: string }>;
	putRepoSecret(input: {
		readonly name: string;
		readonly encryptedValue: string;
		readonly keyId: string;
	}): Promise<void>;
	deleteRepoSecret(input: { readonly name: string }): Promise<void>;
}

/** Names and counts only. A logger that receives a value is a leak, and the spec proves it does not. */
export interface SecretSyncLogger {
	debug?(message: string, meta?: Record<string, unknown>): void;
	info?(message: string, meta?: Record<string, unknown>): void;
	warn?(message: string, meta?: Record<string, unknown>): void;
	error?(message: string, meta?: Record<string, unknown>): void;
}

/** What one build-value sync did. */
export interface BuildValueSyncResult {
	/** The `EW_<NAME>` secrets written, in the order they were written. */
	readonly secretsWritten: readonly string[];
	/** The previously written names deleted, because nothing references them any more. */
	readonly secretsRemoved: readonly string[];
	/** `sha256(sorted (name, fingerprint))` over the values handed in (plan §4.7:918–919). */
	readonly buildInputsHash: string;
	readonly blocked?: {
		readonly reason: AppBuildBlockedReason;
		readonly detail: Record<string, string | number | string[]>;
	};
}

/** What the sync is called with. */
export interface BuildValueSyncInput {
	readonly values: readonly BuildValue[];
	/** The `EW_` names the platform wrote earlier and may now delete (plan §4.7:916–917). */
	readonly previouslyWrittenSecretNames: readonly string[];
}

/** The result of writing §4.10's per-verification prompted-value secret. */
export interface VerifyPromptedSecretResult {
	readonly name: string;
	/** The JSON payload's size in bytes — the same 48,000-byte ceiling every other value has. */
	readonly bytes: number;
	readonly blocked?: {
		readonly reason: AppBuildBlockedReason;
		readonly detail: Record<string, string | number | string[]>;
	};
}

/** The factory's dependencies. */
export interface SecretSyncDependencies {
	readonly port: RepositorySecretPort;
	readonly logger?: SecretSyncLogger;
	/** Test seam for the seal. Defaults to {@link sealSecretValue} — the real libsodium sealed box. */
	readonly seal?: (value: string, publicKey: string) => Promise<string>;
}

/** The operations §4.7 and §4.10 need, bound to one repository port. */
export interface BuildValueSecretSync {
	syncBuildValues(input: BuildValueSyncInput): Promise<BuildValueSyncResult>;
	/** §4.10: the prompted values the owner set, as **one** JSON secret, just before dispatch. */
	writeVerifyPromptedSecret(values: readonly BuildValue[]): Promise<VerifyPromptedSecretResult>;
	/** §4.10: delete that secret by name, on the Build's terminal transition and in the sweep. */
	deleteVerifyPromptedSecret(): Promise<{ readonly deleted: boolean }>;
}

/** GitHub's own secret-name rule, as the github plugin applies it (plan §4.7:914). */
export const GITHUB_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,254}$/;

/** True when GitHub would accept this secret name. */
export function isValidGitHubSecretName(name: string): boolean {
	return GITHUB_SECRET_NAME_PATTERN.test(name) && !name.startsWith('GITHUB_');
}

/** The `EW_` name a build value is stored under. */
export function buildSecretName(valueName: string): string {
	return `${APP_BUILD_SECRET_PREFIX}${valueName}`;
}

/**
 * The sodium build, loaded once.
 *
 * `libsodium-wrappers@0.7.16`'s **ESM** entry (`dist/modules-esm/libsodium-wrappers.mjs`)
 * imports `./libsodium.mjs`, a file that version does not ship — so a static
 * `import _sodium from 'libsodium-wrappers'` (what the github plugin writes, and
 * what its specs hide behind a mock) throws `ERR_MODULE_NOT_FOUND` under Node's
 * ESM resolution. The CJS build it also ships requires the `libsodium` package
 * properly and works, so the loader prefers ESM and falls back to `createRequire`
 * — the same object either way, and the same call sequence the github plugin uses.
 */
let sodiumPromise: Promise<typeof sodiumType> | undefined;

export function loadSodium(): Promise<typeof sodiumType> {
	sodiumPromise ??= (async () => {
		try {
			const imported = (await import('libsodium-wrappers')) as unknown as { default?: typeof sodiumType };
			if (imported.default) return imported.default;
		} catch {
			// Fall through to the CJS build.
		}
		const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
		return require('libsodium-wrappers') as typeof sodiumType;
	})();
	return sodiumPromise;
}

/**
 * Seal one value with a repository public key — the sequence of
 * `github-actions.service.ts:64-73`, unchanged.
 */
export async function sealSecretValue(value: string, publicKey: string): Promise<string> {
	const _sodium = await loadSodium();
	await _sodium.ready;
	const binaryKey = _sodium.from_base64(publicKey, _sodium.base64_variants.ORIGINAL);
	const binarySecret = _sodium.from_string(value);
	const sealed = _sodium.crypto_box_seal(binarySecret, binaryKey);
	return _sodium.to_base64(sealed, _sodium.base64_variants.ORIGINAL);
}

/** `Buffer.byteLength` — the plan's 48,000 **bytes**, not characters (plan §4.7:915). */
function byteLength(value: string): number {
	return Buffer.byteLength(value, 'utf-8');
}

/** GitHub's repository-secret limit answer, recognised without pinning a message GitHub may reword. */
export function isSecretLimitError(error: unknown): boolean {
	const candidate = error as { status?: unknown; message?: unknown } | null | undefined;
	const message = typeof candidate?.message === 'string' ? candidate.message : '';
	if (!/secret/i.test(message)) return false;
	if (candidate?.status === 422 && /limit/i.test(message)) return true;
	return /secret(s)? limit/i.test(message);
}

/**
 * GitHub's answer to a DELETE of a secret that does not exist.
 *
 * Only the removal paths use this: by the time they run, the same call has
 * already fetched the public key (or, for the verification secret, the watch
 * runner is cleaning up after a Build), so a 404 on the DELETE is the name being
 * gone, not the repository.
 */
export function isSecretNotFoundError(error: unknown): boolean {
	return (error as { status?: unknown } | null | undefined)?.status === 404;
}

/**
 * Build the §4.7/§4.10 operations over one repository port.
 *
 * Every operation fetches the public key once, at its own start: a key can rotate
 * between a preparation and a verification, and a cached key would seal a value
 * GitHub then refuses to decrypt.
 */
export function createBuildValueSecretSync(dependencies: SecretSyncDependencies): BuildValueSecretSync {
	const { port, logger } = dependencies;
	const seal = dependencies.seal ?? sealSecretValue;

	async function put(name: string, value: string, publicKey: { key_id: string; key: string }): Promise<void> {
		if (!isValidGitHubSecretName(name)) {
			throw new Error(
				`Invalid secret name "${name}": must be 1-255 characters, contain only uppercase letters, digits, and underscores, start with a letter or underscore, and must not begin with "GITHUB_".`
			);
		}
		await port.putRepoSecret({
			name,
			encryptedValue: await seal(value, publicKey.key),
			keyId: publicKey.key_id
		});
		logger?.debug?.('build value sealed and written', { name });
	}

	return {
		async syncBuildValues(input: BuildValueSyncInput): Promise<BuildValueSyncResult> {
			const buildInputsHash = computeBuildInputsHash(
				input.values.map((value) => ({ name: value.name, fingerprint: value.fingerprint }))
			);

			if (input.values.length > APP_BUILD_MAX_VALUES) {
				return {
					secretsWritten: [],
					secretsRemoved: [],
					buildInputsHash,
					blocked: {
						reason: 'tooManyBuildValues',
						detail: { count: input.values.length, max: APP_BUILD_MAX_VALUES }
					}
				};
			}

			for (const value of input.values) {
				const name = buildSecretName(value.name);
				// The reserved name is checked before the size, so an App spec env entry
				// that collides with §4.10's per-verification secret is refused by name
				// rather than by an unrelated coincidence (plan §4.10:1030–1033).
				if (name === APP_BUILD_VERIFY_PROMPTED_SECRET) {
					return {
						secretsWritten: [],
						secretsRemoved: [],
						buildInputsHash,
						blocked: { reason: 'buildValueNameReserved', detail: { name } }
					};
				}
				if (byteLength(value.value) > APP_BUILD_SECRET_MAX_BYTES) {
					return {
						secretsWritten: [],
						secretsRemoved: [],
						buildInputsHash,
						blocked: { reason: 'buildValueTooLarge', detail: { name } }
					};
				}
			}

			const written: string[] = [];
			// ONE public-key fetch for the whole batch, before the first PUT: the key is
			// what every box in this operation is sealed with (plan §4.7:916).
			const publicKey = await port.getRepoPublicKey();
			try {
				for (const value of input.values) {
					const name = buildSecretName(value.name);
					await put(name, value.value, publicKey);
					written.push(name);
				}
			} catch (error) {
				if (isSecretLimitError(error)) {
					return {
						secretsWritten: [],
						secretsRemoved: [],
						buildInputsHash,
						blocked: { reason: 'secretLimitReached', detail: { count: input.values.length } }
					};
				}
				throw error;
			}

			// Set arithmetic, and only over what the platform wrote before: a name the
			// platform never wrote is never deleted (FR-16/FR-18).
			const referenced = new Set(written);
			const removed: string[] = [];
			for (const name of new Set(input.previouslyWrittenSecretNames)) {
				if (referenced.has(name)) continue;
				try {
					await port.deleteRepoSecret({ name });
					logger?.debug?.('build value secret removed', { name });
				} catch (error) {
					// Already gone: removed all the same, so the caller drops it from the row.
					if (!isSecretNotFoundError(error)) throw error;
					logger?.debug?.('build value secret already absent', { name });
				}
				removed.push(name);
			}

			logger?.info?.('build values synced', { written: written.length, removed: removed.length });
			return { secretsWritten: written, secretsRemoved: removed, buildInputsHash };
		},

		async writeVerifyPromptedSecret(values: readonly BuildValue[]): Promise<VerifyPromptedSecretResult> {
			const payload: Record<string, string> = {};
			for (const value of values) payload[value.name] = value.value;
			const json = JSON.stringify(payload);
			const bytes = byteLength(json);
			if (bytes > APP_BUILD_SECRET_MAX_BYTES) {
				// Name only, and it is the reserved name — never a value (plan §4.10:1019).
				return {
					name: APP_BUILD_VERIFY_PROMPTED_SECRET,
					bytes,
					blocked: { reason: 'buildValueTooLarge', detail: { name: APP_BUILD_VERIFY_PROMPTED_SECRET } }
				};
			}
			await put(APP_BUILD_VERIFY_PROMPTED_SECRET, json, await port.getRepoPublicKey());
			return { name: APP_BUILD_VERIFY_PROMPTED_SECRET, bytes };
		},

		async deleteVerifyPromptedSecret(): Promise<{ readonly deleted: boolean }> {
			try {
				await port.deleteRepoSecret({ name: APP_BUILD_VERIFY_PROMPTED_SECRET });
			} catch (error) {
				// Already gone: an answer, not a failure — the caller clears its record of it.
				if (!isSecretNotFoundError(error)) throw error;
				logger?.debug?.('verification prompted secret already absent', {
					name: APP_BUILD_VERIFY_PROMPTED_SECRET
				});
				return { deleted: false };
			}
			logger?.debug?.('verification prompted secret removed', { name: APP_BUILD_VERIFY_PROMPTED_SECRET });
			return { deleted: true };
		}
	};
}
