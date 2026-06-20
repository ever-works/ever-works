import { describe } from 'vitest';
import { runSecretStoreContractSuite } from '@ever-works/plugin/contracts-conformance';
import { K8sSecretStorePlugin } from '../k8s-secret-store.plugin.js';

describe('K8sSecretStorePlugin — ISecretStoreProvider conformance', () => {
	runSecretStoreContractSuite(() => new K8sSecretStorePlugin());
});
