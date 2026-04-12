export type CodexStepId =
	| 'setup-codex'
	| 'prepare-context'
	| 'generate-items'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

export const CODEX_STEP_IDS: readonly CodexStepId[] = [
	'setup-codex',
	'prepare-context',
	'generate-items',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

export function isCodexStepId(value: string): value is CodexStepId {
	return (CODEX_STEP_IDS as readonly string[]).includes(value);
}

export const BASE_TEMP_DIR = '/tmp/codex-generator';
export const DEFAULT_MODEL = 'gpt-5.4';
