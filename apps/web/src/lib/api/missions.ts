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

/**
 * Phase 7 PR U — shape returned by the `GET /:id/budget` endpoints
 * (both `/me/missions/:id/budget` and `/me/work-proposals/:id/budget`
 * return the same envelope; the discriminator is `ownerType`).
 * Lives here on the missions client since the Mission detail page
 * is the first surface; re-exported for the work-proposals client
 * to consume.
 */
export interface OwnerBudgetSummary {
    ownerType: 'work' | 'mission' | 'idea';
    ownerId: string;
    periodStart: string;
    periodEnd: string;
    currentSpendCents: number;
    capCents: number | null;
    currency: string;
    percentUsed: number | null;
    allowOverage: boolean;
    blocked: boolean;
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

export interface ListMissionsInput {
    status?: MissionStatus;
    search?: string;
    limit?: number;
    offset?: number;
}

function buildListEndpoint(input?: ListMissionsInput): string {
    const params = new URLSearchParams();
    if (input?.status) params.set('status', input.status);
    if (input?.search) params.set('search', input.search);
    if (input?.limit) params.set('limit', String(input.limit));
    if (input?.offset && input.offset > 0) params.set('offset', String(input.offset));
    const qs = params.toString();
    return qs ? `/me/missions?${qs}` : '/me/missions';
}

export const missionsAPI = {
    async list(input?: ListMissionsInput): Promise<Mission[]> {
        return serverFetch<Mission[]>(buildListEndpoint(input), { method: 'GET' });
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

    // Phase 7 PR U — per-Mission current-period spend + GLOBAL cap
    // status. Throws on network failure; callers (Mission detail
    // page) catch + render the friendly empty surface so a flaky
    // API doesn't 500 the page.
    async getBudget(id: string): Promise<OwnerBudgetSummary> {
        return serverFetch<OwnerBudgetSummary>(`/me/missions/${id}/budget`, {
            method: 'GET',
        });
    },

    // Attachment surface — list/add/remove `MissionAttachment` rows.
    // Used by the PromptComposer-driven create flow on /new (Mission
    // template inline-create path) and by future Mission detail
    // attachment sections.
    async listAttachments(id: string): Promise<MissionAttachmentRow[]> {
        return serverFetch<MissionAttachmentRow[]>(`/me/missions/${id}/attachments`, {
            method: 'GET',
        });
    },

    async addAttachment(id: string, uploadId: string): Promise<MissionAttachmentRow> {
        return serverMutation<MissionAttachmentRow>({
            endpoint: `/me/missions/${id}/attachments`,
            data: { uploadId },
            method: 'POST',
            wrapInData: false,
        });
    },

    async removeAttachment(id: string, attachmentId: string): Promise<{ deleted: true }> {
        return serverMutation<{ deleted: true }>({
            endpoint: `/me/missions/${id}/attachments/${attachmentId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // PR-2 (domain-model evolution) — explicit Mission↔Work M:N
    // relation surface (`mission_works`). Rows are cheap references,
    // never ownership: Missions never own Works (invariant I-7) and
    // detaching / deleting a Mission never touches the Work (I-6).

    /** `GET /me/missions/:id/works` → the Works this Mission relates to. */
    async listWorks(id: string): Promise<MissionWorkRelationDto[]> {
        const res = await serverFetch<{ relations: MissionWorkRelationDto[] }>(
            `/me/missions/${id}/works`,
            { method: 'GET' },
        );
        return res.relations;
    },

    /**
     * `POST /me/missions/:id/works` — attach an EXISTING Work with a
     * typed relation. 404 on unknown/foreign Work, 400 on a bad
     * relation, idempotent on duplicates. Returns the updated list.
     */
    async attachWork(
        id: string,
        input: { workId: string; relation: MissionWorkRelation },
    ): Promise<MissionWorkRelationDto[]> {
        const res = await serverMutation<{ relations: MissionWorkRelationDto[] }>({
            endpoint: `/me/missions/${id}/works`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
        return res.relations;
    },

    /**
     * `DELETE /me/missions/:id/works/:workId/:relation` — detach one
     * Mission↔Work edge. The Work itself is never touched (I-6).
     * 404 when the edge doesn't exist.
     */
    async detachWork(
        id: string,
        workId: string,
        relation: MissionWorkRelation,
    ): Promise<{ deleted: true }> {
        return serverMutation<{ deleted: true }>({
            endpoint: `/me/missions/${id}/works/${workId}/${relation}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    /**
     * `GET /me/missions/related-to-work/:workId` — reverse lookup:
     * which of my Missions relate to this Work. Backs the Work
     * Overview "Missions" panel.
     */
    async listMissionsForWork(workId: string): Promise<WorkMissionRelationDto[]> {
        const res = await serverFetch<{ relations: WorkMissionRelationDto[] }>(
            `/me/missions/related-to-work/${workId}`,
            { method: 'GET' },
        );
        return res.relations;
    },
};

/** Row shape returned by `/me/missions/:id/attachments`. */
export interface MissionAttachmentRow {
    readonly id: string;
    readonly missionId: string;
    readonly uploadId: string;
    readonly createdAt: string;
}

/**
 * PR-2 — the six typed Mission↔Work relation kinds. Web-side mirror of
 * `MISSION_WORK_RELATIONS` in
 * `packages/agent/src/entities/mission-work.entity.ts` (kept in
 * lockstep manually, same as the `Mission` DTO above).
 */
export const MISSION_WORK_RELATIONS = [
    'created',
    'improves',
    'operates',
    'markets',
    'researches',
    'retires',
] as const;
export type MissionWorkRelation = (typeof MISSION_WORK_RELATIONS)[number];

/**
 * Row shape returned by `GET/POST /me/missions/:id/works` — a
 * `mission_works` edge hydrated with the Work's display fields
 * (agent-side `MissionWorkWithWork`; `createdAt` wire-serialized to
 * an ISO string, `workName`/`workSlug` null when the Work vanished
 * mid-flight).
 */
export interface MissionWorkRelationDto {
    readonly id: string;
    readonly missionId: string;
    readonly workId: string;
    readonly relation: MissionWorkRelation;
    readonly createdAt: string;
    readonly workName: string | null;
    readonly workSlug: string | null;
}

/**
 * Row shape returned by `GET /me/missions/related-to-work/:workId` —
 * the reverse edge hydrated with the Mission's display fields
 * (agent-side `MissionWorkWithMission`).
 */
export interface WorkMissionRelationDto {
    readonly id: string;
    readonly missionId: string;
    readonly workId: string;
    readonly relation: MissionWorkRelation;
    readonly createdAt: string;
    readonly missionTitle: string | null;
    readonly missionStatus: string | null;
}
