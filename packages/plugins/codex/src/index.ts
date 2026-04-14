/**
 * Codex Generator Plugin
 *
 * Full pipeline plugin that will delegate the entire directory generation
 * to Codex CLI, including managed binary resolution, authentication handling,
 * workspace generation, result collection, and screenshot follow-up support.
 *
 * @packageDocumentation
 */

export { CodexPlugin } from './codex.plugin.js';
export { ensureBinary } from './utils/binary-manager.js';

export type { CodexStepId } from './types.js';
export { CODEX_STEP_IDS, isCodexStepId } from './types.js';

export { default } from './codex.plugin.js';
