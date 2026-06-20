import { describe } from 'vitest';
import { runJobRuntimeContractSuite } from '@ever-works/plugin/contracts-conformance';
import { PgBossJobRuntimePlugin } from '../pgboss-job-runtime.plugin.js';

describe('PgBossJobRuntimePlugin — IJobRuntimeProvider conformance', () => {
	runJobRuntimeContractSuite(() => new PgBossJobRuntimePlugin());
});
