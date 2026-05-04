import type { PipelineStepDefinition } from '@ever-works/plugin';
import type { ActivepiecesStepId } from './types.js';

/**
 * Step definitions for the Activepieces pipeline.
 * All 6 steps run sequentially.
 */
export const STEP_DEFINITIONS: readonly PipelineStepDefinition<ActivepiecesStepId>[] = [
	{
		id: 'validate-activepieces',
		name: 'Validate Activepieces Connection',
		description: 'Verify API key and check that the Activepieces flow is enabled',
		position: { type: 'first' },
		dependencies: [],
		optional: false,
		parallelizable: false,
		estimatedDuration: 3
	},
	{
		id: 'prepare-payload',
		name: 'Prepare Flow Payload',
		description: 'Build input payload from work context, existing items, and config',
		position: { type: 'after', stepId: 'validate-activepieces' },
		dependencies: [{ stepId: 'validate-activepieces', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 2
	},
	{
		id: 'execute-flow',
		name: 'Execute Activepieces Flow',
		description: 'Trigger the Activepieces flow webhook (sync or async with polling)',
		position: { type: 'after', stepId: 'prepare-payload' },
		dependencies: [{ stepId: 'prepare-payload', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 120
	},
	{
		id: 'collect-results',
		name: 'Collect & Validate Results',
		description: 'Parse Activepieces flow output, validate items, and deduplicate',
		position: { type: 'after', stepId: 'execute-flow' },
		dependencies: [{ stepId: 'execute-flow', required: true }],
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
