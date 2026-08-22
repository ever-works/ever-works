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

/**
 * How a Codex run authenticates.
 *
 * - `api-key`      → `OPENAI_API_KEY`, billed per token against the OpenAI platform org.
 * - `access-token` → `CODEX_ACCESS_TOKEN`, a ChatGPT Business/Enterprise workspace
 *                    credential. This is the path OpenAI documents for trusted
 *                    non-interactive runs ("scripts, schedulers, and private CI
 *                    runners"), billed against the workspace Codex entitlement.
 * - `device-auth`  → a materialized `CODEX_HOME` from the user's device-auth session.
 */
export const CODEX_AUTH_MODES = ['api-key', 'access-token', 'device-auth'] as const;

export type CodexAuthMode = (typeof CODEX_AUTH_MODES)[number];

export const CODEX_AUTH_MODE_LABELS: Record<CodexAuthMode, string> = {
	'api-key': 'API key',
	'access-token': 'workspace access token',
	'device-auth': 'device auth'
};

export const BASE_TEMP_DIR = '/tmp/codex-generator';
export const DEFAULT_MODEL = 'gpt-5.4';
export const CODEX_RELEASES_URL = 'https://github.com/openai/codex/releases/download';
export const DEFAULT_CLI_VERSION = '0.120.0';
