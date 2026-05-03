import type { PipelineStepDefinition } from '@ever-works/plugin';
import type { HermesAgentStepId } from './types.js';

export const STEP_DEFINITIONS: readonly PipelineStepDefinition<HermesAgentStepId>[] = [
	{
		id: 'setup-hermes',
		name: 'Setup Hermes',
		description: 'Resolve and verify the Hermes CLI on the backend machine',
		position: { type: 'first' },
		dependencies: [],
		optional: false,
		parallelizable: false,
		estimatedDuration: 5
	},
	{
		id: 'prepare-context',
		name: 'Prepare Context',
		description: 'Create the workspace and seed existing items and metadata',
		position: { type: 'after', stepId: 'setup-hermes' },
		dependencies: [{ stepId: 'setup-hermes', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 5
	},
	{
		id: 'generate-items',
		name: 'Generate Items',
		description: 'Run a Hermes Agent session to research and generate item data',
		position: { type: 'after', stepId: 'prepare-context' },
		dependencies: [{ stepId: 'prepare-context', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 180
	},
	{
		id: 'collect-results',
		name: 'Collect Results',
		description: 'Read structured generation results from the Hermes workspace contract',
		position: { type: 'after', stepId: 'generate-items' },
		dependencies: [{ stepId: 'generate-items', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 5
	},
	{
		id: 'capture-screenshots',
		name: 'Capture Screenshots',
		description: 'Capture screenshots for generated items using the configured screenshot provider',
		position: { type: 'after', stepId: 'collect-results' },
		dependencies: [{ stepId: 'collect-results', required: true }],
		optional: true,
		parallelizable: false,
		estimatedDuration: 30
	},
	{
		id: 'cleanup',
		name: 'Cleanup',
		description: 'Remove temporary Hermes workspace files',
		position: { type: 'last' },
		dependencies: [{ stepId: 'capture-screenshots', required: false }],
		optional: true,
		parallelizable: false,
		estimatedDuration: 2
	}
] as const;
