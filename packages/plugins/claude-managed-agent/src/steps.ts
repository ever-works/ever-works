import type { PipelineStepDefinition } from '@ever-works/plugin';

import type { ClaudeManagedAgentStepId } from './types.js';

export const STEP_DEFINITIONS: readonly PipelineStepDefinition<ClaudeManagedAgentStepId>[] = [
	{
		id: 'configure-managed-agent',
		name: 'Configure Managed Agent',
		description: 'Resolve plugin settings and prepare Anthropic Managed Agents resources.',
		position: { type: 'first' },
		estimatedDuration: 5
	},
	{
		id: 'run-managed-session',
		name: 'Run Managed Session',
		description: 'Start a Claude Managed Agents session and let it research the work topic.',
		position: { type: 'after', stepId: 'configure-managed-agent' },
		estimatedDuration: 120
	},
	{
		id: 'parse-agent-output',
		name: 'Parse Agent Output',
		description: 'Extract normalized work items, taxonomy, and warnings from the session transcript.',
		position: { type: 'after', stepId: 'run-managed-session' },
		estimatedDuration: 5
	},
	{
		id: 'capture-screenshots',
		name: 'Capture Screenshots',
		description: 'Optionally enrich generated items with screenshots from the configured screenshot provider.',
		position: { type: 'last' },
		optional: true,
		estimatedDuration: 30
	}
] as const;
