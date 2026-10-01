import {
	APP_BUILD_MAX_VALUES,
	APP_BUILD_SECRET_MAX_BYTES,
	APP_BUILD_VERIFY_PROMPTED_SECRET,
	computeBuildInputsHash
} from '@ever-works/contracts';
import type { BuildValue } from '@ever-works/plugin';
import { describe, expect, it, vi } from 'vitest';

import {
	buildSecretName,
	createBuildValueSecretSync,
	isSecretLimitError,
	isSecretNotFoundError,
	isValidGitHubSecretName,
	loadSodium,
	sealSecretValue,
	type RepositorySecretPort,
	type SecretSyncLogger
} from '../repo/secret-sync.js';

/**
 * APW-05 T10 — build values into sealed repository secrets (plan §4.7, §4.10).
 *
 * The sealing is **not** mocked. The fake repository port hands out a real
 * libsodium public key (generated in the test), and the case that matters opens
 * every sealed box with the matching private key and reads the value back: a
 * sealed box that cannot be opened with the key GitHub holds is a value GitHub
 * will refuse, and no amount of call-counting would notice. (Sodium is reached
 * through `loadSodium`, which falls back to the package's CJS build — its ESM
 * entry imports a file that version does not ship. That is a real finding, not a
 * test convenience; see the loader's docstring.)
 */

const SENTINEL = 'super-secret-value-that-must-not-be-logged-0123456789';

interface FakePort {
	readonly port: RepositorySecretPort;
	readonly put: Array<{ name: string; encryptedValue: string; keyId: string }>;
	readonly deleted: string[];
	readonly calls: string[];
	readonly publicKeyFetches: number;
	readonly privateKey: Uint8Array;
}

/** A repository port over a real keypair, with every call recorded. */
async function fakePort(
	options: {
		failPut?: (call: number) => Error | null;
		/** A scripted DELETE answer by name: the error GitHub would throw, or `null` to succeed. */
		failDelete?: (name: string) => Error | null;
	} = {}
): Promise<FakePort> {
	const _sodium = await loadSodium();
	await _sodium.ready;
	const keypair = _sodium.crypto_box_keypair();
	const record = {
		put: [] as FakePort['put'],
		deleted: [] as string[],
		calls: [] as string[],
		publicKeyFetches: 0
	};
	const port: RepositorySecretPort = {
		async getRepoPublicKey() {
			record.calls.push('getRepoPublicKey');
			record.publicKeyFetches += 1;
			return { key_id: 'key-1', key: _sodium.to_base64(keypair.publicKey, _sodium.base64_variants.ORIGINAL) };
		},
		async putRepoSecret(input) {
			record.calls.push(`put:${input.name}`);
			const failure = options.failPut?.(record.put.length + 1);
			if (failure) throw failure;
			record.put.push(input);
		},
		async deleteRepoSecret(input) {
			record.calls.push(`delete:${input.name}`);
			const failure = options.failDelete?.(input.name);
			if (failure) throw failure;
			record.deleted.push(input.name);
		}
	};
	return {
		port,
		get put() {
			return record.put;
		},
		get deleted() {
			return record.deleted;
		},
		get calls() {
			return record.calls;
		},
		get publicKeyFetches() {
			return record.publicKeyFetches;
		},
		privateKey: keypair.privateKey as Uint8Array
	} as FakePort;
}

/** Open a sealed box with the keypair the fake repository holds — what GitHub does with the key it owns. */
async function openSealed(sealed: string, privateKey: Uint8Array, publicKey: string): Promise<string> {
	const _sodium = await loadSodium();
	await _sodium.ready;
	const bytes = _sodium.from_base64(sealed, _sodium.base64_variants.ORIGINAL);
	const opened = _sodium.crypto_box_seal_open(
		bytes,
		_sodium.from_base64(publicKey, _sodium.base64_variants.ORIGINAL),
		privateKey
	);
	return _sodium.to_string(opened);
}

function value(name: string, secretValue: string, overrides: Partial<BuildValue> = {}): BuildValue {
	return { name, value: secretValue, secret: true, fromBuildService: false, fingerprint: 'v1', ...overrides };
}

/** The public key the fake hands out, for the cases that open a box themselves. */
async function fakePublicKey(port: FakePort): Promise<string> {
	const key = await port.port.getRepoPublicKey();
	return key.key;
}

describe('secret sync — the sealing itself (plan §4.7)', () => {
	it('seals with a real libsodium box that the repository key can open', async () => {
		const fake = await fakePort();
		const publicKey = await fakePublicKey(fake);
		const sealed = await sealSecretValue(SENTINEL, publicKey);
		expect(sealed).not.toContain(SENTINEL);
		expect(await openSealed(sealed, fake.privateKey, publicKey)).toBe(SENTINEL);
	});

	it('applies the github plugin name rule, and refuses a name GitHub would reject', () => {
		expect(isValidGitHubSecretName('EW_DATABASE_URL')).toBe(true);
		expect(isValidGitHubSecretName('_PRIVATE')).toBe(true);
		expect(isValidGitHubSecretName('GITHUB_TOKEN')).toBe(false);
		expect(isValidGitHubSecretName('lower_case')).toBe(false);
		expect(isValidGitHubSecretName('EW-DASH')).toBe(false);
		expect(buildSecretName('DATABASE_URL')).toBe('EW_DATABASE_URL');
	});

	it('throws — never blocks a Build — on a name only a programming error can produce', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		await expect(
			sync.syncBuildValues({ values: [value('lower', SENTINEL)], previouslyWrittenSecretNames: [] })
		).rejects.toThrow(/Invalid secret name/);
		expect(fake.put).toEqual([]);
	});
});

describe('secret sync — writing the values (ACC-05-13)', () => {
	it('fetches the public key once and seals every value with it', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const values = [value('DATABASE_URL', 'postgres://user:pw@127.0.0.1:5432/app'), value('API_KEY', SENTINEL)];
		const result = await sync.syncBuildValues({ values, previouslyWrittenSecretNames: [] });

		expect(result.secretsWritten).toEqual(['EW_DATABASE_URL', 'EW_API_KEY']);
		expect(result.secretsRemoved).toEqual([]);
		expect(fake.publicKeyFetches).toBe(1);
		expect(fake.put.map((entry) => entry.name)).toEqual(['EW_DATABASE_URL', 'EW_API_KEY']);
		expect(fake.put.every((entry) => entry.keyId === 'key-1')).toBe(true);

		const publicKey = await fakePublicKey(fake);
		expect(await openSealed(fake.put[0].encryptedValue, fake.privateKey, publicKey)).toBe(values[0].value);
		expect(await openSealed(fake.put[1].encryptedValue, fake.privateKey, publicKey)).toBe(SENTINEL);
	});

	it('writes every fromEnv value before anything could dispatch a Build', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		await sync.syncBuildValues({
			values: [value('A', 'a'), value('B', 'b'), value('C', 'c')],
			previouslyWrittenSecretNames: []
		});
		fake.calls.push('startBuild');
		const lastPut = fake.calls.lastIndexOf('put:EW_C');
		expect(lastPut).toBeGreaterThan(-1);
		expect(lastPut).toBeLessThan(fake.calls.indexOf('startBuild'));
	});

	it('computes the buildInputsHash the contract function computes, and stays stable under reordering', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const values = [
			value('B', 'b', { fingerprint: 'v2' }),
			value('A', 'a', { fingerprint: 'sha256:abc' }),
			value('C', 'c', { fromBuildService: true, fingerprint: 'sha256:def' })
		];
		const forwards = await sync.syncBuildValues({ values, previouslyWrittenSecretNames: [] });
		const backwards = await sync.syncBuildValues({
			values: [...values].reverse(),
			previouslyWrittenSecretNames: []
		});

		expect(forwards.buildInputsHash).toBe(
			computeBuildInputsHash([
				{ name: 'B', fingerprint: 'v2' },
				{ name: 'A', fingerprint: 'sha256:abc' },
				{ name: 'C', fingerprint: 'sha256:def' }
			])
		);
		expect(backwards.buildInputsHash).toBe(forwards.buildInputsHash);
		expect(forwards.buildInputsHash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('secret sync — the three limits and the reserved name (plan §4.7, §4.10)', () => {
	it('refuses more than the contract maximum, naming both numbers', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const values = Array.from({ length: APP_BUILD_MAX_VALUES + 1 }, (_, index) => value(`V${index}`, 'x'));
		const result = await sync.syncBuildValues({ values, previouslyWrittenSecretNames: [] });

		expect(result.blocked).toEqual({
			reason: 'tooManyBuildValues',
			detail: { count: APP_BUILD_MAX_VALUES + 1, max: APP_BUILD_MAX_VALUES }
		});
		expect(fake.put).toEqual([]);
		expect(fake.calls).not.toContain('getRepoPublicKey');
	});

	it('accepts exactly the maximum', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const values = Array.from({ length: APP_BUILD_MAX_VALUES }, (_, index) => value(`V${index}`, 'x'));
		const result = await sync.syncBuildValues({ values, previouslyWrittenSecretNames: [] });
		expect(result.blocked).toBeUndefined();
		expect(result.secretsWritten).toHaveLength(APP_BUILD_MAX_VALUES);
	});

	it('refuses an oversized value by name only — never by value', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const oversized = `${'x'.repeat(APP_BUILD_SECRET_MAX_BYTES)}${SENTINEL}`;
		const result = await sync.syncBuildValues({
			values: [value('BIG', oversized)],
			previouslyWrittenSecretNames: []
		});

		expect(result.blocked?.reason).toBe('buildValueTooLarge');
		expect(Object.keys(result.blocked?.detail ?? {})).toEqual(['name']);
		expect(result.blocked?.detail.name).toBe('EW_BIG');
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
		expect(fake.put).toEqual([]);
	});

	it('measures bytes, not characters', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		// 24,000 two-byte characters are 48,000 bytes — exactly at the limit.
		const atLimit = '\u00e9'.repeat(APP_BUILD_SECRET_MAX_BYTES / 2);
		expect(Buffer.byteLength(atLimit, 'utf-8')).toBe(APP_BUILD_SECRET_MAX_BYTES);
		expect(
			(await sync.syncBuildValues({ values: [value('AT', atLimit)], previouslyWrittenSecretNames: [] })).blocked
		).toBeUndefined();
		const over = `${atLimit}\u00e9`;
		expect(
			(await sync.syncBuildValues({ values: [value('OVER', over)], previouslyWrittenSecretNames: [] })).blocked
				?.reason
		).toBe('buildValueTooLarge');
	});

	it('refuses an env name that maps onto the reserved verification secret', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const result = await sync.syncBuildValues({
			values: [value('VERIFY__PROMPTED', SENTINEL)],
			previouslyWrittenSecretNames: []
		});

		expect(result.blocked).toEqual({
			reason: 'buildValueNameReserved',
			detail: { name: APP_BUILD_VERIFY_PROMPTED_SECRET }
		});
		expect(fake.put).toEqual([]);
	});

	it('maps the repository secret limit to secretLimitReached', async () => {
		const fake = await fakePort({
			failPut: () =>
				Object.assign(new Error('Validation Failed: this repository has reached its secret limit'), {
					status: 422
				})
		});
		const sync = createBuildValueSecretSync({ port: fake.port });
		const result = await sync.syncBuildValues({
			values: [value('A', 'a'), value('B', 'b')],
			previouslyWrittenSecretNames: []
		});

		expect(result.blocked?.reason).toBe('secretLimitReached');
		expect(result.secretsWritten).toEqual([]);
		expect(isSecretLimitError(Object.assign(new Error('secret limit reached'), { status: 422 }))).toBe(true);
		expect(isSecretLimitError(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(false);
	});

	it('rethrows an error that is not the secret limit', async () => {
		const fake = await fakePort({ failPut: () => Object.assign(new Error('Bad credentials'), { status: 401 }) });
		const sync = createBuildValueSecretSync({ port: fake.port });
		await expect(
			sync.syncBuildValues({ values: [value('A', 'a')], previouslyWrittenSecretNames: [] })
		).rejects.toThrow('Bad credentials');
	});
});

describe('secret sync — removal is set arithmetic (FR-16, FR-18)', () => {
	it('deletes only names the platform wrote earlier and nothing references now', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const result = await sync.syncBuildValues({
			values: [value('KEEP', 'k'), value('NEW', 'n')],
			previouslyWrittenSecretNames: ['EW_KEEP', 'EW_GONE', 'EW_ALSO_GONE']
		});

		expect(result.secretsRemoved).toEqual(['EW_GONE', 'EW_ALSO_GONE']);
		expect(fake.deleted).toEqual(['EW_GONE', 'EW_ALSO_GONE']);
		expect(fake.deleted).not.toContain('EW_KEEP');
	});

	it('never deletes a name it did not write, even one that looks like its own', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const result = await sync.syncBuildValues({ values: [value('A', 'a')], previouslyWrittenSecretNames: [] });

		expect(result.secretsRemoved).toEqual([]);
		expect(fake.calls.filter((call) => call.startsWith('delete:'))).toEqual([]);
		// The owner's own `EW_SOMETHING` repository secret is not in the previous set,
		// so it is not in the delete set — the whole reason the set is arithmetic.
		expect(fake.deleted).not.toContain('EW_SOMETHING');
	});

	it('counts a previously written name GitHub no longer has as removed, and keeps deleting the rest', async () => {
		// An owner deleted EW_A by hand, or an earlier preparation deleted it and then
		// failed before the row was written. GitHub answers the DELETE with 404; the
		// name is gone either way, and throwing here would fail every later
		// preparation of the Work on the same stale name, forever.
		const fake = await fakePort({
			failDelete: (name) => (name === 'EW_A' ? Object.assign(new Error('Not Found'), { status: 404 }) : null)
		});
		const sync = createBuildValueSecretSync({ port: fake.port });
		const result = await sync.syncBuildValues({ values: [], previouslyWrittenSecretNames: ['EW_A', 'EW_B'] });

		expect(result.secretsRemoved).toEqual(['EW_A', 'EW_B']);
		expect(fake.calls).toEqual(['getRepoPublicKey', 'delete:EW_A', 'delete:EW_B']);
		expect(fake.deleted).toEqual(['EW_B']);
	});

	it('still throws when a DELETE fails for any reason other than the name being gone', async () => {
		const fake = await fakePort({
			failDelete: () => Object.assign(new Error('Server Error'), { status: 500 })
		});
		const sync = createBuildValueSecretSync({ port: fake.port });
		await expect(sync.syncBuildValues({ values: [], previouslyWrittenSecretNames: ['EW_A'] })).rejects.toThrow(
			'Server Error'
		);
	});

	it('recognises only a 404 as the name being gone', () => {
		expect(isSecretNotFoundError(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(true);
		expect(isSecretNotFoundError(Object.assign(new Error('Server Error'), { status: 500 }))).toBe(false);
		expect(isSecretNotFoundError(Object.assign(new Error('Forbidden'), { status: 403 }))).toBe(false);
		expect(isSecretNotFoundError(new Error('Not Found'))).toBe(false);
		expect(isSecretNotFoundError(null)).toBe(false);
		expect(isSecretNotFoundError(undefined)).toBe(false);
	});

	it('deletes a previously written name the moment it stops being referenced', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const first = await sync.syncBuildValues({ values: [value('A', 'a')], previouslyWrittenSecretNames: [] });
		const second = await sync.syncBuildValues({ values: [], previouslyWrittenSecretNames: first.secretsWritten });

		expect(second.secretsWritten).toEqual([]);
		expect(second.secretsRemoved).toEqual(['EW_A']);
		expect(fake.deleted).toEqual(['EW_A']);
	});
});

describe('secret sync — the per-verification prompted secret (plan §4.10)', () => {
	it('writes one JSON secret under the reserved name, and it opens', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const result = await sync.writeVerifyPromptedSecret([value('FIRST', 'one'), value('SECOND', SENTINEL)]);

		expect(result).toEqual({ name: APP_BUILD_VERIFY_PROMPTED_SECRET, bytes: expect.any(Number) });
		expect(result.bytes).toBeLessThanOrEqual(APP_BUILD_SECRET_MAX_BYTES);
		expect(fake.put.map((entry) => entry.name)).toEqual([APP_BUILD_VERIFY_PROMPTED_SECRET]);
		const publicKey = await fakePublicKey(fake);
		const json = await openSealed(fake.put[0].encryptedValue, fake.privateKey, publicKey);
		expect(JSON.parse(json)).toEqual({ FIRST: 'one', SECOND: SENTINEL });
		// One secret, and it is a JSON object — never one secret per prompted name.
		expect(fake.put).toHaveLength(1);
	});

	it('refuses an oversize payload by the reserved name only', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const result = await sync.writeVerifyPromptedSecret([value('BIG', 'x'.repeat(APP_BUILD_SECRET_MAX_BYTES))]);
		expect(result.blocked).toEqual({
			reason: 'buildValueTooLarge',
			detail: { name: APP_BUILD_VERIFY_PROMPTED_SECRET }
		});
		expect(fake.put).toEqual([]);
	});

	it('deletes the verification secret by name', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		expect(await sync.deleteVerifyPromptedSecret()).toEqual({ deleted: true });
		expect(fake.deleted).toEqual([APP_BUILD_VERIFY_PROMPTED_SECRET]);
	});

	it('answers deleted:false, never a throw, when the verification secret is already gone', async () => {
		// The watch runner clears `verifySecretNames` on any answer; a throw would
		// leave it set, and the orphan pass would retry the same 404 forever.
		const fake = await fakePort({ failDelete: () => Object.assign(new Error('Not Found'), { status: 404 }) });
		const sync = createBuildValueSecretSync({ port: fake.port });
		expect(await sync.deleteVerifyPromptedSecret()).toEqual({ deleted: false });
		expect(fake.calls).toEqual([`delete:${APP_BUILD_VERIFY_PROMPTED_SECRET}`]);
	});

	it('still throws when the verification secret DELETE fails for another reason', async () => {
		const fake = await fakePort({ failDelete: () => Object.assign(new Error('Server Error'), { status: 500 }) });
		const sync = createBuildValueSecretSync({ port: fake.port });
		await expect(sync.deleteVerifyPromptedSecret()).rejects.toThrow('Server Error');
	});
});

describe('secret sync — a value never leaves through a name, a log or an error', () => {
	it('keeps the value out of every logger call, on the happy path and on every refusal', async () => {
		const debug = vi.fn();
		const info = vi.fn();
		const warn = vi.fn();
		const error = vi.fn();
		const logger: Required<SecretSyncLogger> = { debug, info, warn, error };
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port, logger });

		await sync.syncBuildValues({
			values: [value('A', SENTINEL), value('B', 'b')],
			previouslyWrittenSecretNames: ['EW_OLD']
		});
		await sync.writeVerifyPromptedSecret([value('PROMPTED', SENTINEL)]);
		await sync.deleteVerifyPromptedSecret();
		await sync.syncBuildValues({
			values: [value('VERIFY__PROMPTED', SENTINEL)],
			previouslyWrittenSecretNames: []
		});
		await sync.syncBuildValues({
			values: [value('BIG', `${'x'.repeat(APP_BUILD_SECRET_MAX_BYTES)}${SENTINEL}`)],
			previouslyWrittenSecretNames: []
		});

		const calls = [debug, info, warn, error].flatMap((spy) => spy.mock.calls);
		expect(calls.length).toBeGreaterThan(0);
		expect(JSON.stringify(calls)).not.toContain(SENTINEL);
		// Non-vacuity: the log lines do carry names and counts.
		expect(JSON.stringify(calls)).toContain('EW_A');
		expect(JSON.stringify(calls)).toContain('"written":2');
	});

	it('keeps the value out of the refusal the caller stores', async () => {
		const fake = await fakePort();
		const sync = createBuildValueSecretSync({ port: fake.port });
		const oversized = `${'x'.repeat(APP_BUILD_SECRET_MAX_BYTES)}${SENTINEL}`;
		const results = [
			await sync.syncBuildValues({ values: [value('BIG', oversized)], previouslyWrittenSecretNames: [] }),
			await sync.writeVerifyPromptedSecret([value('BIG', oversized)]),
			await sync.syncBuildValues({
				values: [value('VERIFY__PROMPTED', SENTINEL)],
				previouslyWrittenSecretNames: []
			}),
			await sync.syncBuildValues({
				values: Array.from({ length: APP_BUILD_MAX_VALUES + 1 }, () => value('MANY', SENTINEL)),
				previouslyWrittenSecretNames: []
			})
		];
		for (const result of results) {
			expect(result.blocked).toBeDefined();
			expect(JSON.stringify(result)).not.toContain(SENTINEL);
		}
	});
});
