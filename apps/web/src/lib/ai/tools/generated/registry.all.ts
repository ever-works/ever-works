import { OPERATION_REGISTRY, type OperationSpec } from './registry';
import { WAVE2_OPERATIONS } from './registry.wave2';
import { WAVE3_OPERATIONS } from './registry.wave3';

/**
 * The complete generated-tool registry: Wave-1 seed + Wave-2 expansion +
 * Wave-3 reads, deduped at build time (earlier waves win). buildGeneratedTools
 * consumes this.
 */
const seen = new Set<string>();
export const ALL_OPERATIONS: OperationSpec[] = [
    ...OPERATION_REGISTRY,
    ...WAVE2_OPERATIONS,
    ...WAVE3_OPERATIONS,
].filter((op) => (seen.has(op.toolName) ? false : (seen.add(op.toolName), true)));
