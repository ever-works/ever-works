import type { PipelineStepDefinition } from '@ever-works/plugin';
import type { MakeStepId } from './types.js';

/**
 * Step definitions for the Make.com pipeline.
 * All 6 steps run sequentially.
 */
export const STEP_DEFINITIONS: readonly PipelineStepDefinition<MakeStepId>[] = [
	{
		id: 'validate-make',
		name: 'Validate Make.com Connection',
		description: 'Verify API key and check that the scenario or hook is reachable',
		position: { type: 'first' },
		dependencies: [],
		optional: false,
		parallelizable: false,
		estimatedDuration: 3
	},
	{
		id: 'prepare-payload',
		name: 'Prepare Scenario Payload',
		description: 'Build input payload from work context, existing items, and config',
		position: { type: 'after', stepId: 'validate-make' },
		dependencies: [{ stepId: 'validate-make', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 2
	},
	{
		id: 'execute-scenario',
		name: 'Execute Make.com Scenario',
		description: 'Run the scenario via REST API (with polling) or invoke a webhook URL',
		position: { type: 'after', stepId: 'prepare-payload' },
		dependencies: [{ stepId: 'prepare-payload', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 120
	},
	{
		id: 'collect-results',
		name: 'Collect & Validate Results',
		description: 'Parse Make.com scenario output, validate items, and deduplicate',
		position: { type: 'after', stepId: 'execute-scenario' },
		dependencies: [{ stepId: 'execute-scenario', required: true }],
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
