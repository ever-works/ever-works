import { describe } from 'vitest';
import { runJobRuntimeTenantContractSuite } from '@ever-works/plugin/contracts-conformance';
import { TemporalJobRuntimePlugin } from '../temporal-job-runtime.plugin.js';

describe('TemporalJobRuntimePlugin — tenant overlay conformance', () => {
	runJobRuntimeTenantContractSuite(
		() => new TemporalJobRuntimePlugin(),
		{
			tenantA: {
				tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
				providerId: 'temporal',
				credentialVersion: 1,
				credentials: { namespace: 'tenant-a' }
			},
			tenantB: {
				tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
				providerId: 'temporal',
				credentialVersion: 1,
				credentials: { namespace: 'tenant-b' }
			}
		}
	);
});
