import type {
    Mission,
    MissionGuardrailsOverride,
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
    title: string;
    description: string;
    type: MissionType;
    status: MissionStatus;
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
    guardrailsOverride: MissionGuardrailsOverride | null;
    missionTemplateRepo: string | null;
    missionRepo: string | null;
    /** Self-FK for Mission Clone traceability (Phase 0 PR 0.10,
     *  Decision A25). NULL for direct-created Missions. */
    sourceMissionId: string | null;
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
        title: mission.title,
        description: mission.description,
        type: mission.type,
        status: mission.status,
        schedule: mission.schedule ?? null,
        autoBuildWorks: mission.autoBuildWorks,
        outstandingIdeasCap: mission.outstandingIdeasCap ?? null,
        guardrailsOverride: mission.guardrailsOverride ?? null,
        missionTemplateRepo: mission.missionTemplateRepo ?? null,
        missionRepo: mission.missionRepo ?? null,
        sourceMissionId: mission.sourceMissionId ?? null,
        createdAt: mission.createdAt,
        updatedAt: mission.updatedAt,
    };
}
