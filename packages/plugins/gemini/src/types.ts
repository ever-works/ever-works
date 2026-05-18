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
 * Default CLI version to install
 */
export const DEFAULT_CLI_VERSION = 'latest';

/**
 * Default Gemini model
 */
export const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Maximum stdout/stderr buffer size (10MB) to prevent OOM
 */
export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Timeout for SIGKILL after SIGTERM (5 seconds)
 */
export const KILL_TIMEOUT_MS = 5000;
