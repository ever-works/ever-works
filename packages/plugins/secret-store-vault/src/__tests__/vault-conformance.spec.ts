import { describe } from 'vitest';
import { runSecretStoreContractSuite } from '@ever-works/plugin/contracts-conformance';
import { VaultSecretStorePlugin } from '../vault-secret-store.plugin.js';

/**
 * EW-742 P3.2 / P6 — Vault plugin runs the shared
 * `ISecretStoreProvider` conformance suite against itself. See
 * `packages/plugin/src/contracts/__tests__/secret-store-conformance.spec.ts`
 * for the 6 fail-open invariants covered.
 *
 * Vault plugin recognises `vault:` pointers. Defaults from the
 * conformance suite use `this-scheme-does-not-exist:...` for the
 * unknown-scheme check, `inline:` malformed-base64 for malformed, and
 * `fake:...` for missing-resource — all of which Vault treats as
 * unknown-scheme and returns null (fail-open). That satisfies the
 * contract without needing live Vault.
 */

describe('VaultSecretStorePlugin — ISecretStoreProvider conformance', () => {
	runSecretStoreContractSuite(() => new VaultSecretStorePlugin());
});
