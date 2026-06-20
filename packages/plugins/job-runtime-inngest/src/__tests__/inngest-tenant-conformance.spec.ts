import { describe } from 'vitest';
import { runJobRuntimeTenantContractSuite } from '@ever-works/plugin/contracts-conformance';
import { InngestJobRuntimePlugin } from '../inngest-job-runtime.plugin.js';

describe('InngestJobRuntimePlugin — tenant overlay conformance', () => {
	runJobRuntimeTenantContractSuite(
		() => new InngestJobRuntimePlugin(),
		{
			tenantA: {
				tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
				providerId: 'inngest',
				credentialVersion: 1,
				credentials: { eventKey: 'ek-a', signingKey: 'sk-a' }
			},
			tenantB: {
				tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
				providerId: 'inngest',
				credentialVersion: 1,
				credentials: { eventKey: 'ek-b', signingKey: 'sk-b' }
			}
		}
	);
});
