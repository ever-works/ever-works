import { describe } from 'vitest';
import { runJobRuntimeTenantContractSuite } from '@ever-works/plugin/contracts-conformance';
import { PgBossJobRuntimePlugin } from '../pgboss-job-runtime.plugin.js';

describe('PgBossJobRuntimePlugin — tenant overlay conformance', () => {
	runJobRuntimeTenantContractSuite(
		() => new PgBossJobRuntimePlugin(),
		{
			tenantA: {
				tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
				providerId: 'pgboss',
				credentialVersion: 1,
				credentials: { schema: 'tenant_a' }
			},
			tenantB: {
				tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
				providerId: 'pgboss',
				credentialVersion: 1,
				credentials: { schema: 'tenant_b' }
			}
		}
	);
});
