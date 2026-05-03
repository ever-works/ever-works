import type { PipelineStepDefinition } from '@ever-works/plugin';
import type { ZapierStepId } from './types.js';

/**
 * Step definitions for the Zapier pipeline.
 * All 6 steps run sequentially.
 */
export const STEP_DEFINITIONS: readonly PipelineStepDefinition<ZapierStepId>[] = [
	{
		id: 'validate-zapier',
		name: 'Validate Zapier Connection',
		description: 'Verify access token and confirm the Zapier action exists',
		position: { type: 'first' },
		dependencies: [],
		optional: false,
		parallelizable: false,
		estimatedDuration: 3
	},
	{
		id: 'prepare-payload',
		name: 'Prepare Action Payload',
		description: 'Build input payload from work context, existing items, and config',
		position: { type: 'after', stepId: 'validate-zapier' },
		dependencies: [{ stepId: 'validate-zapier', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 2
	},
	{
		id: 'execute-action',
		name: 'Execute Zapier Action',
		description: 'Invoke the Zapier action via the SDK and await the result',
		position: { type: 'after', stepId: 'prepare-payload' },
		dependencies: [{ stepId: 'prepare-payload', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 120
	},
	{
		id: 'collect-results',
		name: 'Collect & Validate Results',
		description: 'Parse the action output into work items and deduplicate',
		position: { type: 'after', stepId: 'execute-action' },
		dependencies: [{ stepId: 'execute-action', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 5
	},
	{
		id: 'capture-screenshots',
		name: 'Capture Screenshots',
		description: 'Capture screenshots for generated items',
		position: { type: 'after', stepId: 'collect-results' },
		dependencies: [{ stepId: 'collect-results', required: true }],
		optional: true,
		parallelizable: false,
		estimatedDuration: 30
	},
	{
		id: 'cleanup',
		name: 'Cleanup',
		description: 'Release resources and clear temporary data',
		position: { type: 'last' },
		dependencies: [{ stepId: 'capture-screenshots', required: false }],
		optional: true,
		parallelizable: false,
		estimatedDuration: 1
	}
];
