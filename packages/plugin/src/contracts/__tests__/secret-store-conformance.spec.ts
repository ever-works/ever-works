/**
 * EW-742 P3.2 / P6 — runtime conformance suite for `ISecretStoreProvider`.
 *
 * Every concrete provider plugin (`@ever-works/secret-store-{vault,k8s,
 * infisical,doppler,aws-sm,gcp-sm,azure-kv}-plugin` + the in-process
 * default) MUST pass these tests. Mirrors the
 * `runJobRuntimeContractSuite` pattern shipped in #1462.
 *
 * Encoded invariants (from `secret-store.interface.ts`):
 *
 *   1. Required `IPlugin` metadata is shaped correctly
 *      (id, name, version, category='secret-store-resolver',
 *      capabilities include 'secret-store-resolve').
 *   2. `resolveSecret` is async and returns `Record<string, unknown> | null`.
 *   3. Fail-open: an unknown scheme returns `null`, NEVER throws.
 *   4. Fail-open: a known scheme with a malformed payload returns
 *      `null`, NEVER throws.
 *   5. Fail-open: a known scheme with a missing-resource pointer
 *      returns `null`, NEVER throws.
 *   6. Lifecycle hooks `onLoad`/`onUnload` (when present) tolerate
 *      a no-op call.
 *
 * Usage:
 *
 *   ```ts
 *   import { describe } from 'vitest';
 *   import { runSecretStoreContractSuite } from '@ever-works/plugin/contracts-conformance';
 *   import { VaultSecretStorePlugin } from '../vault-secret-store.plugin.js';
 *
 *   describe('Vault secret-store — contract', () => {
 *     runSecretStoreContractSuite(() => new VaultSecretStorePlugin());
 *   });
 *   ```
 *
 * Self-applies against the in-memory fake at the bottom.
 */

import { describe, expect, it } from 'vitest';
import type { ISecretStoreProvider } from '../capabilities/secret-store.interface.js';
import { SECRET_STORE_CAPABILITIES } from '../capabilities/secret-store.interface.js';
import { createInMemorySecretStoreProvider } from './fakes/in-memory-secret-store-provider.js';

export interface SecretStoreContractOptions {
	/**
	 * Pointers the provider is GUARANTEED to fail-open on (return null
	 * without throwing). Suite uses these for tests 3-5. Provide at
	 * least one of each kind: unknown-scheme, malformed-payload,
	 * missing-resource.
	 */
	readonly failOpenPointers?: {
		readonly unknownScheme?: string;
		readonly malformedPayload?: string;
		readonly missingResource?: string;
	};
}

const DEFAULT_FAIL_OPEN: Required<NonNullable<SecretStoreContractOptions['failOpenPointers']>> = {
	unknownScheme: 'this-scheme-does-not-exist:any/payload',
	// Inline scheme: base64-decode produces invalid JSON.
	malformedPayload: 'inline:bm9wZS1ub3QtanNvbg==',
	// Vault/k8s/etc. all interpret this as a missing key.
	missingResource: 'fake:definitely-not-a-real-key'
};

export function runSecretStoreContractSuite(
	factory: () => ISecretStoreProvider | Promise<ISecretStoreProvider>,
	options: SecretStoreContractOptions = {}
): void {
	describe('ISecretStoreProvider contract (EW-742 P3.2 / P6)', () => {
		const buildProvider = async (): Promise<ISecretStoreProvider> => factory();

		it('1. IPlugin metadata is shaped correctly', async () => {
			const p = await buildProvider();
			expect(typeof p.id).toBe('string');
			expect(p.id.length).toBeGreaterThan(0);
			expect(typeof p.name).toBe('string');
			expect(typeof p.version).toBe('string');
			expect(p.version).toMatch(/^\d+\.\d+\.\d+/);
			expect(p.category).toBe('secret-store-resolver');
			expect(Array.isArray(p.capabilities)).toBe(true);
			expect(p.capabilities, 'missing capability: secret-store-resolve').toContain(
				SECRET_STORE_CAPABILITIES.RESOLVE
			);
		});

		it('2. resolveSecret is async and returns Record<string, unknown> | null', async () => {
			const p = await buildProvider();
			const pointer = options.failOpenPointers?.unknownScheme ?? DEFAULT_FAIL_OPEN.unknownScheme;
			const result = p.resolveSecret(pointer);
			expect(result).toBeInstanceOf(Promise);
			const resolved = await result;
			// Either null (fail-open) or a plain object — never a primitive or array.
			if (resolved !== null) {
				expect(typeof resolved).toBe('object');
				expect(Array.isArray(resolved)).toBe(false);
			}
		});

		it('3. fail-open: unknown scheme returns null, does NOT throw', async () => {
			const p = await buildProvider();
			const pointer = options.failOpenPointers?.unknownScheme ?? DEFAULT_FAIL_OPEN.unknownScheme;
			await expect(p.resolveSecret(pointer)).resolves.toBeNull();
		});

		it('4. fail-open: malformed payload returns null, does NOT throw', async () => {
			const p = await buildProvider();
			const pointer = options.failOpenPointers?.malformedPayload ?? DEFAULT_FAIL_OPEN.malformedPayload;
			// Some providers strictly return null on a malformed payload they
			// recognise the scheme for; others may not know the inline:
			// scheme at all — both are valid (return null either way).
			await expect(p.resolveSecret(pointer)).resolves.toBeNull();
		});

		it('5. fail-open: missing-resource pointer returns null, does NOT throw', async () => {
			const p = await buildProvider();
			const pointer = options.failOpenPointers?.missingResource ?? DEFAULT_FAIL_OPEN.missingResource;
			await expect(p.resolveSecret(pointer)).resolves.toBeNull();
		});

		it('6. onLoad/onUnload tolerate a no-op call', async () => {
			const p = await buildProvider();
			const ctx = {} as Parameters<NonNullable<ISecretStoreProvider['onLoad']>>[0];
			if (p.onLoad) {
				await expect(p.onLoad(ctx)).resolves.toBeUndefined();
			}
			if (p.onUnload) {
				await expect(p.onUnload()).resolves.toBeUndefined();
			}
		});
	});
}

// Self-application — exercises the contract against the in-memory
// reference impl every time `pnpm --filter @ever-works/plugin test`
// runs. Drift in the contract fails here before any concrete plugin's
// CI run notices.
runSecretStoreContractSuite(() => createInMemorySecretStoreProvider({ seeded: { hello: 'world' } }));
