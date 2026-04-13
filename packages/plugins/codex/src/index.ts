/**
 * Codex Generator Plugin
 *
 * Full pipeline plugin that will delegate the entire directory generation
 * to Codex CLI. The initial scaffold registers the plugin and form schema
 * before the external runner is implemented.
 *
 * @packageDocumentation
 */

export { CodexPlugin } from './codex.plugin.js';
export { ensureBinary } from './utils/binary-manager.js';

export type { CodexStepId } from './types.js';
export { CODEX_STEP_IDS, isCodexStepId } from './types.js';

export { default } from './codex.plugin.js';
