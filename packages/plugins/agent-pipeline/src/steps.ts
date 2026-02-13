import type { PipelineStepDefinition } from '@ever-works/plugin';
import type { AgentPipelineStepId } from './types.js';

/**
 * Step definitions for the Agent Pipeline.
 * All 5 steps run sequentially.
 */
export const STEP_DEFINITIONS: readonly PipelineStepDefinition<AgentPipelineStepId>[] = [
	{
		id: 'prepare-context',
		name: 'Prepare Context',
		description: 'Load existing items and metadata',
		position: { type: 'first' },
		dependencies: [],
		optional: false,
		parallelizable: false,
		estimatedDuration: 2
	},
	{
		id: 'generate-items',
		name: 'Generate Items',
		description: 'AI agent researches and creates items',
		position: { type: 'after', stepId: 'prepare-context' },
		dependencies: [{ stepId: 'prepare-context', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 120
	},
	{
		id: 'collect-results',
		name: 'Collect Results',
		description: 'Gather generated items',
		position: { type: 'after', stepId: 'generate-items' },
		dependencies: [{ stepId: 'generate-items', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 2
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
		description: 'Release resources',
		position: { type: 'last' },
		dependencies: [{ stepId: 'capture-screenshots', required: false }],
		optional: true,
		parallelizable: false,
		estimatedDuration: 1
	}
];
