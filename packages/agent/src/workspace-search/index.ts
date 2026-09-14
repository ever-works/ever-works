export { WorkspaceSearchModule } from './workspace-search.module';
export {
    WorkspaceSearchService,
    WORKSPACE_SEARCH_SOURCE_READER,
    type WorkspaceSearchSourceReader,
} from './workspace-search.service';
export { fold } from './fold';
export {
    scoreCandidate,
    compareHits,
    orderAndCutGroups,
    isSubsequence,
    KIND_PRIORITY,
    MATCH_SCORES,
    RECENT_OPEN_BOOST,
    FRESHNESS_BOOST,
    FUZZY_MIN_QUERY_LENGTH,
} from './ranking';
export { WORKSPACE_SEARCH_SOURCES } from './sources';
export type {
    WorkspaceSearchScope,
    WorkspaceSearchFilters,
    WorkspaceSearchCandidate,
    WorkspaceSearchSourceDefinition,
    WorkspaceSearchSourceQuery,
    WorkspaceSearchSourceResult,
} from './workspace-search.types';
