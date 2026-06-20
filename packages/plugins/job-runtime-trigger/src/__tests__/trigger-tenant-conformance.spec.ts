import { describe } from 'vitest';
import { runJobRuntimeTenantContractSuite } from '@ever-works/plugin/contracts-conformance';
import { TriggerJobRuntimePlugin } from '../trigger-job-runtime.plugin.js';

describe('TriggerJobRuntimePlugin — tenant overlay conformance', () => {
	runJobRuntimeTenantContractSuite(
		() => new TriggerJobRuntimePlugin(),
		{
			tenantA: {
				tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
				providerId: 'trigger',
				credentialVersion: 1,
				credentials: { projectAccessToken: 'tr_pat_a', projectRef: 'proj_a' }
			},
			tenantB: {
				tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
				providerId: 'trigger',
				credentialVersion: 1,
				credentials: { projectAccessToken: 'tr_pat_b', projectRef: 'proj_b' }
			}
		}
	);
});
