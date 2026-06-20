import { describe } from 'vitest';
import { runJobRuntimeContractSuite } from '@ever-works/plugin/contracts-conformance';
import { TemporalJobRuntimePlugin } from '../temporal-job-runtime.plugin.js';

describe('TemporalJobRuntimePlugin — IJobRuntimeProvider conformance', () => {
	runJobRuntimeContractSuite(() => new TemporalJobRuntimePlugin());
});
