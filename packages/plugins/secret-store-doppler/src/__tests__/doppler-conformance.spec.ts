import { describe } from 'vitest';
import { runSecretStoreContractSuite } from '@ever-works/plugin/contracts-conformance';
import { DopplerSecretStorePlugin } from '../doppler-secret-store.plugin.js';

describe('DopplerSecretStorePlugin — ISecretStoreProvider conformance', () => {
	runSecretStoreContractSuite(() => new DopplerSecretStorePlugin());
});
