import type { PipelineStepDefinition } from '@ever-works/plugin';
import type { GeminiStepId } from './types.js';

/**
 * Step definitions for the Gemini pipeline.
 * All 6 steps run sequentially.
 */
export const STEP_DEFINITIONS: readonly PipelineStepDefinition<GeminiStepId>[] = [
	{
		id: 'setup-gemini',
		name: 'Setup Gemini CLI',
		description: 'Install and verify the Gemini CLI runtime',
		position: { type: 'first' },
		dependencies: [],
		optional: false,
		parallelizable: false,
		estimatedDuration: 10
	},
	{
		id: 'prepare-context',
		name: 'Prepare Context',
		description: 'Create workspace and seed existing items and metadata',
		position: { type: 'after', stepId: 'setup-gemini' },
		dependencies: [{ stepId: 'setup-gemini', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 5
	},
	{
		id: 'generate-items',
		name: 'Generate Items',
		description: 'Execute Gemini CLI to research and generate items',
		position: { type: 'after', stepId: 'prepare-context' },
		dependencies: [{ stepId: 'prepare-context', required: true }],
		optional: false,
		parallelizable: false,
		estimatedDuration: 120
	},
	{
		id: 'collect-results',
		name: 'Collect Results',
		description: 'Read generated item files and metadata from workspace',
		position: { type: 'after', stepId: 'generate-items' },
		dependencies: [{ stepId: 'generate-items', required: true }],
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
		description: 'Remove temporary workspace files',
		position: { type: 'last' },
		dependencies: [{ stepId: 'capture-screenshots', required: false }],
		optional: true,
		parallelizable: false,
		estimatedDuration: 2
	}
];
