import { describe } from 'vitest';
import { runJobRuntimeContractSuite } from '@ever-works/plugin/contracts-conformance';
import { InngestJobRuntimePlugin } from '../inngest-job-runtime.plugin.js';

describe('InngestJobRuntimePlugin — IJobRuntimeProvider conformance', () => {
	runJobRuntimeContractSuite(() => new InngestJobRuntimePlugin());
});
