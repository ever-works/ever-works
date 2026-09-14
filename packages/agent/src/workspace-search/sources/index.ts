import type { ObjectLiteral } from 'typeorm';
import type { WorkspaceSearchKind } from '@ever-works/contracts/api';
import type { WorkspaceSearchSourceDefinition } from '../workspace-search.types';
import { agentSource } from './agent.source';
import { ideaSource } from './idea.source';
import { knowledgeSource } from './knowledge.source';
import { missionSource } from './mission.source';
import { skillSource } from './skill.source';
import { taskSource } from './task.source';
import { teamSource } from './team.source';
import { workSource } from './work.source';

/**
 * Live fan-out sources, one per searchable kind. A kind absent from this map
 * is simply not searched (it contributes no group and is not degraded).
 */
export const WORKSPACE_SEARCH_SOURCES: Partial<
    Record<WorkspaceSearchKind, WorkspaceSearchSourceDefinition<ObjectLiteral>>
> = {
    mission: missionSource as unknown as WorkspaceSearchSourceDefinition<ObjectLiteral>,
    task: taskSource as unknown as WorkspaceSearchSourceDefinition<ObjectLiteral>,
    agent: agentSource as unknown as WorkspaceSearchSourceDefinition<ObjectLiteral>,
    work: workSource as unknown as WorkspaceSearchSourceDefinition<ObjectLiteral>,
    idea: ideaSource as unknown as WorkspaceSearchSourceDefinition<ObjectLiteral>,
    skill: skillSource as unknown as WorkspaceSearchSourceDefinition<ObjectLiteral>,
    team: teamSource as unknown as WorkspaceSearchSourceDefinition<ObjectLiteral>,
    knowledge: knowledgeSource as unknown as WorkspaceSearchSourceDefinition<ObjectLiteral>,
};

export {
    agentSource,
    ideaSource,
    knowledgeSource,
    missionSource,
    skillSource,
    taskSource,
    teamSource,
    workSource,
};
export {
    runSource,
    applyOwnerAccess,
    buildContainsPattern,
    buildSubsequencePattern,
} from './run-source';
