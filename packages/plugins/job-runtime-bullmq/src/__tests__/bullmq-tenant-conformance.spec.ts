import { describe } from 'vitest';
import { runJobRuntimeTenantContractSuite } from '@ever-works/plugin/contracts-conformance';
import { BullMqJobRuntimePlugin } from '../bullmq-job-runtime.plugin.js';

/**
 * EW-742 P6 T36-T40 — BullMQ plugin runs the shared tenant-overlay
 * conformance suite. Layers cross-tenant isolation, graceful drain,
 * and force-invalidate eviction on top of the base contract suite.
 *
 * Default tenants in the suite use `providerId: 'bullmq'` and empty
 * `credentials` — the plugin's `bindToTenant` accepts that and uses
 * the platform-default Redis prefix.
 */
describe('BullMqJobRuntimePlugin — tenant overlay conformance', () => {
	runJobRuntimeTenantContractSuite(() => new BullMqJobRuntimePlugin(), {
		tenantA: {
			tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
			providerId: 'bullmq',
			credentialVersion: 1,
			credentials: { queuePrefix: 'tenant-a' }
		},
		tenantB: {
			tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
			providerId: 'bullmq',
			credentialVersion: 1,
			credentials: { queuePrefix: 'tenant-b' }
		}
	});
});
