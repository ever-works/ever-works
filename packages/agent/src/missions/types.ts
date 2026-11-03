import {
    normalizeMissionOutputMode,
    normalizeMissionTaskOutput,
    type MissionOutputMode,
    type MissionTaskOutput,
} from './mission-task-output';
import type {
    Mission,
    MissionGuardrailsOverride,
    MissionOutcome,
    MissionStatus,
    MissionType,
} from '../entities/mission.entity';

/**
 * DTO shape returned by `MissionsService.list` / `get` / `create`.
 * Wire-format projection of the `Mission` entity (no relations,
 * `Date` instances kept as-is for the API layer to serialize).
 *
 * Spec §1.3 + Phase 3 PR G (Missions/Ideas/Works build).
 */
export interface MissionDto {
    id: string;
    tenantId: string | null;
    organizationId: string | null;
    title: string;
    description: string;
    type: MissionType;
    status: MissionStatus;
    /** PR-3 - conclusion verdict; NULL until a human records one at Complete. */
    outcome: MissionOutcome | null;
    completedAt: Date | null;
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
    guardrailsOverride: MissionGuardrailsOverride | null;
    missionTemplateRepo: string | null;
    missionRepo: string | null;
    /** Self-FK for Mission Clone traceability (Phase 0 PR 0.10,
     *  Decision A25). NULL for direct-created Missions. */
    sourceMissionId: string | null;
    /** APW-08 T34 (FR-51) — `ideas` / `tasks` / `both`. */
    outputMode: MissionOutputMode;
    /** APW-08 T34 — the Task output's bounds, normalized (defaults when unset). */
    taskOutput: MissionTaskOutput;
    /** APW-08 T34 (FR-54) — when the "nothing to file" notice was last recorded. */
    taskOutputNoticeAt: Date | null;
    /**
     * APW-08 T34 — set on a write's answer only: `noAppWorkRelation` when the Mission files Tasks
     * but has no App Work attached as Improves or Operates (accepted all the same, S27).
     */
    warnings?: string[];
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Small mapper used by the service + (later) the controller to
 * normalize entity → DTO. Centralized so future additions to
 * `Mission` only need to touch one map.
 */
export function toMissionDto(mission: Mission): MissionDto {
    return {
        id: mission.id,
        tenantId: mission.tenantId ?? null,
        organizationId: mission.organizationId ?? null,
        title: mission.title,
        description: mission.description,
        type: mission.type,
        status: mission.status,
        outcome: mission.outcome ?? null,
        completedAt: mission.completedAt ?? null,
        schedule: mission.schedule ?? null,
        autoBuildWorks: mission.autoBuildWorks,
        outstandingIdeasCap: mission.outstandingIdeasCap ?? null,
        guardrailsOverride: mission.guardrailsOverride ?? null,
        missionTemplateRepo: mission.missionTemplateRepo ?? null,
        missionRepo: mission.missionRepo ?? null,
        sourceMissionId: mission.sourceMissionId ?? null,
        outputMode: normalizeMissionOutputMode(mission.outputMode),
        taskOutput: normalizeMissionTaskOutput(mission.taskOutput),
        taskOutputNoticeAt: mission.taskOutputNoticeAt ?? null,
        createdAt: mission.createdAt,
        updatedAt: mission.updatedAt,
    };
}
