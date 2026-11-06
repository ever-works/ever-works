import * as os from 'os';
import * as path from 'path';

/**
 * Step IDs for the Gemini pipeline.
 * All steps run sequentially (non-parallelizable).
 */
export type GeminiStepId =
	| 'setup-gemini'
	| 'prepare-context'
	| 'generate-items'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

/**
 * All step IDs as an array for iteration
 */
export const GEMINI_STEP_IDS: readonly GeminiStepId[] = [
	'setup-gemini',
	'prepare-context',
	'generate-items',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/**
 * Type guard for GeminiStepId
 */
export function isGeminiStepId(value: string): value is GeminiStepId {
	return (GEMINI_STEP_IDS as readonly string[]).includes(value);
}

/**
 * Base temporary work for all Gemini operations
 */
// Forward-slash form so downstream `path.posix.join` calls don't treat the
// drive letter as relative on Windows. Node accepts `/` on Windows for FS ops.
export const BASE_TEMP_DIR = path.join(os.tmpdir(), 'gemini-generator').replace(/\\/g, '/');

/**
 * NPM package used to install Gemini CLI
 */
export const GEMINI_NPM_PACKAGE = '@google/gemini-cli';

/**
 * Default CLI version to install.
 *
 * Security (EW-720): pinned to an exact semver rather than the `latest`
 * dist-tag so a new session does not auto-fetch and execute an unreviewed
 * Gemini CLI release (supply-chain substitution risk). This mirrors the
 * exact-version defaults of the sibling CLI plugins (codex/opencode/claude-code).
 *
 * The value is the version `@google/gemini-cli@latest` resolved to at pin time
 * (0.67.0, 2026-11-04; `npm view @google/gemini-cli`). The `'latest'` sentinel
 * remains an explicit opt-in via plugin settings and is still treated specially
 * by the binary-manager.
 *
 * Models refresh 2026-11-05: the previous pin, 0.45.2, silently rewrote any model
 * id ending in "flash" to its own default (google-gemini/gemini-cli#28859, fixed
 * in 0.61.0), and native Gemini 3.8 Flash support arrived in 0.62.0. The flags the
 * runner passes (`-p`, `--output-format`, `--sandbox`, `--approval-mode`, `--model`)
 * are unchanged in 0.67.0.
 */
export const DEFAULT_CLI_VERSION = '0.67.0';

/**
 * Default Gemini model: Gemini 3.8 Flash, the Gemini API's "most intelligent Flash"
 * (GA 2026-09-02; https://aistudio.google.com/docs/models, checked 2026-11-05).
 *
 * Changing this moves every config that never saved a model onto the new default
 * (models refresh decision B, 2026-11-05: no backfill, because Ever Works has no
 * real users yet). Saved models are untouched.
 */
export const DEFAULT_MODEL = 'gemini-3.8-flash';

/**
 * Maximum stdout/stderr buffer size (10MB) to prevent OOM
 */
export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Timeout for SIGKILL after SIGTERM (5 seconds)
 */
export const KILL_TIMEOUT_MS = 5000;
