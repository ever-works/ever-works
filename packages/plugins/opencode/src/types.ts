import * as os from 'os';
import * as path from 'path';

/**
 * Step IDs for the OpenCode pipeline.
 * All steps run sequentially (non-parallelizable).
 */
export type OpenCodeStepId =
	| 'setup-opencode'
	| 'prepare-context'
	| 'generate-items'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

/**
 * All step IDs as an array for iteration
 */
export const OPENCODE_STEP_IDS: readonly OpenCodeStepId[] = [
	'setup-opencode',
	'prepare-context',
	'generate-items',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

/**
 * Type guard for OpenCodeStepId
 */
export function isOpenCodeStepId(value: string): value is OpenCodeStepId {
	return (OPENCODE_STEP_IDS as readonly string[]).includes(value);
}

/**
 * Base temporary work for all OpenCode operations
 */
// Forward-slash form so downstream `path.posix.join` calls don't treat the
// drive letter as relative on Windows. Node accepts `/` on Windows for FS ops.
export const BASE_TEMP_DIR = path.join(os.tmpdir(), 'opencode-generator').replace(/\\/g, '/');

/**
 * GitHub repository for OpenCode CLI distribution. The project moved from `sst/opencode`
 * to `anomalyco/opencode`; the old paths only answer with 301 redirects
 * (https://github.com/anomalyco/opencode, checked 2026-11-05). Release assets are served from
 * github.com / release-assets.githubusercontent.com, which the binary-manager host allow-list
 * already covers.
 */
export const OPENCODE_GITHUB_REPO = 'anomalyco/opencode';

/**
 * Default CLI version to download: v1.19.5, the GitHub "Latest" release of the v1 line
 * (2026-10-28; https://github.com/anomalyco/opencode/releases/tag/v1.19.5). The v2.x line is a
 * separate `@opencode/cli` package that the official installer skips. Asset names are
 * unchanged since v1.0.223 and every asset carries a sha256 digest.
 */
export const DEFAULT_CLI_VERSION = 'v1.19.5';

/**
 * Maximum stdout/stderr buffer size (10MB) to prevent OOM
 */
export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Timeout for SIGKILL after SIGTERM (5 seconds)
 */
export const KILL_TIMEOUT_MS = 5000;
