import { describe } from 'vitest';
import { runSecretStoreContractSuite } from '@ever-works/plugin/contracts-conformance';
import { InfisicalSecretStorePlugin } from '../infisical-secret-store.plugin.js';

describe('InfisicalSecretStorePlugin — ISecretStoreProvider conformance', () => {
	runSecretStoreContractSuite(() => new InfisicalSecretStorePlugin());
});
