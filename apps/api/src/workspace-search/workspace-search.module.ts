import { Module } from '@nestjs/common';
import { WorkspaceSearchModule as AgentWorkspaceSearchModule } from '@ever-works/agent/workspace-search';
import { WorkspaceSearchController } from './workspace-search.controller';

/**
 * Workspace search — API module (AW-01). Thin HTTP surface over the
 * agent-side `WorkspaceSearchService`. `ScopeContextService` is provided
 * globally by `ScopeModule`, so it needs no import.
 */
@Module({
    imports: [AgentWorkspaceSearchModule],
    controllers: [WorkspaceSearchController],
})
export class WorkspaceSearchModule {}
