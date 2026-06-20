import { describe } from 'vitest';
import { runSecretStoreContractSuite } from '@ever-works/plugin/contracts-conformance';
import { AzureKvSecretStorePlugin } from '../azure-kv-secret-store.plugin.js';

describe('AzureKvSecretStorePlugin — ISecretStoreProvider conformance', () => {
	runSecretStoreContractSuite(() => new AzureKvSecretStorePlugin());
});
