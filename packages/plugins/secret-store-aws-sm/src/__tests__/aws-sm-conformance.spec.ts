import { describe } from 'vitest';
import { runSecretStoreContractSuite } from '@ever-works/plugin/contracts-conformance';
import { AwsSmSecretStorePlugin } from '../aws-sm-secret-store.plugin.js';

describe('AwsSmSecretStorePlugin — ISecretStoreProvider conformance', () => {
	runSecretStoreContractSuite(() => new AwsSmSecretStorePlugin());
});
