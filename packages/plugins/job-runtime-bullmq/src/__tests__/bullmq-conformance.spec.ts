import { describe } from 'vitest';
import { runJobRuntimeContractSuite } from '@ever-works/plugin/contracts-conformance';
import { BullMqJobRuntimePlugin } from '../bullmq-job-runtime.plugin.js';

/**
 * EW-742 P6 — BullMQ plugin runs the shared `IJobRuntimeProvider`
 * conformance suite against itself. See
 * `packages/plugin/src/contracts/__tests__/job-runtime-conformance.spec.ts`
 * for what the suite covers; this file is just the entry point that
 * proves the BullMQ implementation satisfies the contract.
 *
 * The plugin's `dispatchers` is a throwing-stub Proxy when no operator
 * has wired real dispatchers; the conformance suite tolerates that
 * (the dispatchers-access probe checks that mere property access
 * doesn't throw, only that calling the function may throw — which is
 * how the stub works).
 */

describe('BullMqJobRuntimePlugin — IJobRuntimeProvider conformance', () => {
	runJobRuntimeContractSuite(() => new BullMqJobRuntimePlugin());
});
