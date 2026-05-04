import type { PipelineStepDefinition } from '@ever-works/plugin';
import type { SimAiStepId } from './types.js';

/**
 * Step definitions for the SIM AI pipeline.
 * All 6 steps run sequentially.
 */
export const STEP_DEFINITIONS: readonly PipelineStepDefinition<SimAiStepId>[] = [
	{
		id: 'validate-sim',
		name: 'Validate SIM Connection',
		description: 'Verify API key and check that the SIM workflow is deployed',
		position: { type: 'first' },
		dependencies: [],
		optional: false,
		parallelizable: false,
		estimatedDuration: 3
	},
	{
		id: 'prepare-payload',
		name: 'Prepare Workflow Payload',
		description: 'Build input payload from work context, existing items, and config',
		position: { type: 'after', stepId: 'validate-sim' },
		dependencies: [{ stepId: 'validate-sim', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 2
	},
	{
		id: 'execute-workflow',
		name: 'Execute SIM Workflow',
		description: 'Call SIM API to execute the workflow (sync or async with polling)',
		position: { type: 'after', stepId: 'prepare-payload' },
		dependencies: [{ stepId: 'prepare-payload', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 120
	},
	{
		id: 'collect-results',
		name: 'Collect & Validate Results',
		description: 'Parse SIM workflow output, validate items, and deduplicate',
		position: { type: 'after', stepId: 'execute-workflow' },
		dependencies: [{ stepId: 'execute-workflow', required: true }],
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
