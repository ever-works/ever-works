/**
 * Context-file and memory-fact vocabulary for the agent package (AW-07).
 *
 * The same role `kb-types.ts` plays for the Knowledge Base: one import site
 * inside `@ever-works/agent` for the enums and limits the entities, services
 * and specs share. Every value is RE-EXPORTED from `@ever-works/contracts`,
 * never redeclared — a limit that exists twice is a limit that drifts.
 */
export {
    CONTEXT_FILE_LOAD_MODES,
    CONTEXT_FILE_REVISION_KEEP,
    CONTEXT_FILE_REVISION_KEEP_DAYS,
    MAX_ALWAYS_LOADED_WORKSPACE_FILES,
    MEMORY_FACT_ACTIVE_MAX,
    MEMORY_FACT_BODY_MAX,
    MEMORY_FACT_FORGET_ALL_CONFIRMATION,
    MEMORY_FACT_FORGET_RETENTION_DAYS,
    MEMORY_FACT_LIST_LIMIT_MAX,
    MEMORY_FACT_ORIGINS,
    MEMORY_FACT_PINNED_MAX,
    MEMORY_FACT_PROPOSED_MAX,
    MEMORY_FACT_SCOPES,
    MEMORY_FACT_SEARCH_MIN_SCORE,
    MEMORY_FACT_SEARCH_TOP_K,
    MEMORY_FACT_STATUSES,
    MEMORY_FACT_SWEEP_BATCH_MAX,
    WORKSPACE_CONTEXT_FILE_DEFAULT_LOAD_MODES,
    WORKSPACE_CONTEXT_FILE_SLUGS,
    isMemoryFactScope,
    isMemoryFactStatus,
    isWorkspaceContextFileSlug,
} from '@ever-works/contracts';
export type {
    ContextFileLoadMode,
    MemoryFactOrigin,
    MemoryFactScope,
    MemoryFactStatus,
    WorkspaceContextFileSlug,
} from '@ever-works/contracts';
