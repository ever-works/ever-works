import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Phase 6 PR Q — web-side mirror of the agent-side `MissionDto`
 * (`packages/agent/src/missions/types.ts`). Kept in lockstep
 * manually because the API contract is what the page consumes
 * and we don't want a runtime dep on the agent package from
 * apps/web for a tiny DTO.
 *
 * Date fields are wire-serialized as ISO strings on the API
 * side (NestJS's class-transformer default). On the web, we
 * keep them as strings until a renderer actually formats them.
 */
export type MissionStatus = 'active' | 'paused' | 'completed' | 'failed';
export type MissionType = 'one-shot' | 'scheduled';

export interface Mission {
    id: string;
    title: string;
    description: string;
    type: MissionType;
    status: MissionStatus;
    schedule: string | null;
    autoBuildWorks: boolean;
    outstandingIdeasCap: number | null;
    guardrailsOverride: Record<string, unknown> | null;
    missionTemplateRepo: string | null;
    missionRepo: string | null;
    sourceMissionId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CreateMissionInput {
    title?: string;
    description: string;
    type: MissionType;
    schedule?: string | null;
    autoBuildWorks?: boolean;
    outstandingIdeasCap?: number | null;
    guardrailsOverride?: Record<string, unknown> | null;
    missionTemplateRepo?: string | null;
}

export interface UpdateMissionInput {
    title?: string;
    description?: string;
    type?: MissionType;
    schedule?: string | null;
    autoBuildWorks?: boolean;
    outstandingIdeasCap?: number | null;
    guardrailsOverride?: Record<string, unknown> | null;
    missionTemplateRepo?: string | null;
}

export interface CloneMissionResult {
    mission: Mission;
    ideasCloned: number;
    ideasSkipped: number;
}

/** Phase 3 PR J — shape of the `POST /:id/run-now` response. */
export interface MissionRunNowResponse {
    status:
        | 'noop-placeholder'
        | 'queued'
        | 'spawned'
        | 'cap-hit'
        | 'no-ideas'
        | 'failed'
        | 'cron-no-match';
    missionId: string;
    ideasCreated?: number;
    ideasQueued?: number;
    message?: string;
}

export const missionsAPI = {
    async list(): Promise<Mission[]> {
        return serverFetch<Mission[]>('/me/missions', { method: 'GET' });
    },

    async get(id: string): Promise<Mission | null> {
        try {
            return await serverFetch<Mission>(`/me/missions/${id}`, { method: 'GET' });
        } catch {
            return null;
        }
    },

    async create(input: CreateMissionInput): Promise<Mission> {
        return serverMutation<Mission>({
            endpoint: '/me/missions',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async update(id: string, input: UpdateMissionInput): Promise<Mission> {
        return serverMutation<Mission>({
            endpoint: `/me/missions/${id}`,
            data: input,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async remove(id: string): Promise<{ deleted: true }> {
        return serverMutation<{ deleted: true }>({
            endpoint: `/me/missions/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async pause(id: string): Promise<Mission> {
        return serverMutation<Mission>({
            endpoint: `/me/missions/${id}/pause`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async resume(id: string): Promise<Mission> {
        return serverMutation<Mission>({
            endpoint: `/me/missions/${id}/resume`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async complete(id: string): Promise<Mission> {
        return serverMutation<Mission>({
            endpoint: `/me/missions/${id}/complete`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async runNow(id: string): Promise<MissionRunNowResponse> {
        return serverMutation<MissionRunNowResponse>({
            endpoint: `/me/missions/${id}/run-now`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async clone(id: string, title?: string): Promise<CloneMissionResult> {
        return serverMutation<CloneMissionResult>({
            endpoint: `/me/missions/${id}/clone`,
            data: title ? { title } : {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
