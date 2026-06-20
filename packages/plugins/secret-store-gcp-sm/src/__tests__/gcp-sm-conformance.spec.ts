import { describe } from 'vitest';
import { runSecretStoreContractSuite } from '@ever-works/plugin/contracts-conformance';
import { GcpSmSecretStorePlugin } from '../gcp-sm-secret-store.plugin.js';

describe('GcpSmSecretStorePlugin — ISecretStoreProvider conformance', () => {
	runSecretStoreContractSuite(() => new GcpSmSecretStorePlugin());
});
