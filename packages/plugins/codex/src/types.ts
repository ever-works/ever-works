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
/**
 * Default Codex model. GPT-6.1 Sol has been Codex's own default since CLI 0.161.0
 * ("GPT-6.1 Sol is now the default model"; https://github.com/openai/codex/releases,
 * https://learn.chatgpt.com/docs/models, checked 2026-11-05).
 *
 * Changing this moves every config that never saved a model onto the new default (models
 * refresh decision B, 2026-11-05: no backfill, because Ever Works has no real users yet).
 * Saved models are untouched.
 */
export const DEFAULT_MODEL = 'gpt-6.1-sol';
export const CODEX_RELEASES_URL = 'https://github.com/openai/codex/releases/download';
/**
 * Pinned Codex CLI release (`rust-v0.166.0`, latest stable on 2026-10-29;
 * https://github.com/openai/codex/releases/tag/rust-v0.166.0). It runs every model in the
 * catalog, including GPT-6.1 Terra (0.159.0+ per the docs; 0.165/0.166 per the release notes).
 */
export const DEFAULT_CLI_VERSION = '0.166.0';
