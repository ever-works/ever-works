import * as os from 'os';
import * as path from 'path';

export type HermesAgentStepId =
	| 'setup-hermes'
	| 'prepare-context'
	| 'generate-items'
	| 'collect-results'
	| 'capture-screenshots'
	| 'cleanup';

export const HERMES_AGENT_STEP_IDS: readonly HermesAgentStepId[] = [
	'setup-hermes',
	'prepare-context',
	'generate-items',
	'collect-results',
	'capture-screenshots',
	'cleanup'
] as const;

export function isHermesAgentStepId(value: string): value is HermesAgentStepId {
	return (HERMES_AGENT_STEP_IDS as readonly string[]).includes(value);
}

export const BASE_TEMP_DIR = path.join(os.tmpdir(), 'hermes-agent-generator');

export const DEFAULT_PROFILE = 'default';
// Security (audit C: RCE via terminal + --yolo): `terminal` is intentionally
// NOT in the default toolset. The Hermes child processes untrusted / web-ingested
// content, and `terminal` combined with `--yolo` (auto-approve) turns a successful
// prompt injection into arbitrary command execution on the API host. Operators who
// need shell access for a trusted profile can opt in by setting the (global-scoped,
// operator-only) `toolsets` setting explicitly, e.g. 'web,terminal,skills'. The
// hardcoded fallback in resolveHermesRuntimeSettings (pipeline-helpers.ts) MUST stay
// identical to this value.
export const DEFAULT_TOOLSETS = 'web,skills';
export const DEFAULT_MAX_TURNS = 90;
export const DEFAULT_PROVIDER = '';
export const DEFAULT_MODEL = '';
export const DEFAULT_BINARY_PATH = 'hermes';

export const RESULT_FILE_NAME = 'hermes-result.json';
export const RESULT_SCHEMA_FILE_NAME = 'hermes-result.schema.json';

export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
export const KILL_TIMEOUT_MS = 5000;
