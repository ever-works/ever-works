import type { PipelineStepDefinition } from '@ever-works/plugin';
import type { ComposioStepId } from './types.js';

/**
 * Step definitions for the Composio pipeline.
 * All 6 steps run sequentially.
 */
export const STEP_DEFINITIONS: readonly PipelineStepDefinition<ComposioStepId>[] = [
	{
		id: 'validate-composio',
		name: 'Validate Composio Connection',
		description:
			'Verify the API key, the tool exists, and the user has an active connected account for the toolkit',
		position: { type: 'first' },
		dependencies: [],
		optional: false,
		parallelizable: false,
		estimatedDuration: 3
	},
	{
		id: 'prepare-payload',
		name: 'Prepare Tool Payload',
		description: 'Build the arguments payload from work context, existing items, and config',
		position: { type: 'after', stepId: 'validate-composio' },
		dependencies: [{ stepId: 'validate-composio', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 2
	},
	{
		id: 'execute-tool',
		name: 'Execute Composio Tool',
		description: 'Invoke the Composio tool for the resolved user and await the result',
		position: { type: 'after', stepId: 'prepare-payload' },
		dependencies: [{ stepId: 'prepare-payload', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 120
	},
	{
		id: 'collect-results',
		name: 'Collect & Validate Results',
		description: 'Parse the tool output into work items and deduplicate',
		position: { type: 'after', stepId: 'execute-tool' },
		dependencies: [{ stepId: 'execute-tool', required: true }],
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
