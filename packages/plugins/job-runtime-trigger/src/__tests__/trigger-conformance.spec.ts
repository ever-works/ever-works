import { describe } from 'vitest';
import { runJobRuntimeContractSuite } from '@ever-works/plugin/contracts-conformance';
import { TriggerJobRuntimePlugin } from '../trigger-job-runtime.plugin.js';

describe('TriggerJobRuntimePlugin — IJobRuntimeProvider conformance', () => {
	runJobRuntimeContractSuite(() => new TriggerJobRuntimePlugin());
});
