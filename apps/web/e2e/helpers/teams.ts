import { type APIRequestContext, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './api';
import { createOrganizationViaAPI, type Organization } from './organizations';

/**
 * Teams & Prebuilt Companies helpers (#1647 / #1713).
 *
 * Verified live against http://127.0.0.1:3100 (sqlite in-memory, the e2e
 * driver) before any assertion was written:
 *
 *   All routes nest under /api/organizations/:orgId and are guarded by
 *   AuthSessionGuard + OrganizationOwnershipGuard (only the org OWNER
 *   reaches them; a non-owner hits a 403/404 wall — 404-never-403 for
 *   sub-resources, org-level guard may 403). Writes carry @OrgAdmin().
 *
 *   POST   .../teams { name, slug?, description?, parentTeamId?, managerAgentId?, avatarIcon? }
 *            → 201 { id, name, slug (auto-derived when omitted), description|null,
 *                    parentTeamId|null, managerAgentId|null, avatarIcon|null,
 *                    organizationId, createdAt, updatedAt }
 *   GET    .../teams                       → TeamResponse[] (flat, parentTeamId edges)
 *   GET    .../teams/:teamId               → TeamDetailResponse { …, members[], childTeamIds[] }
 *   PATCH  .../teams/:teamId               → 200 TeamResponse (re-parent is cycle-checked)
 *   DELETE .../teams/:teamId               → 204 (children re-parent to deleted team's parent)
 *   GET    .../teams/:teamId/members       → TeamMemberView[]
 *   POST   .../teams/:teamId/members { memberType:'agent'|'user', memberId, role?:'lead'|'member' }
 *            → 201 TeamMemberView | 409 already a member
 *   DELETE .../teams/:teamId/members/:memberId?memberType=agent|user → 204
 *   GET    .../teams/:teamId/resources     → { work[], task[], agent[], mission[], idea[] }
 *   POST   .../teams/:teamId/resources { resourceType, resourceId } → 201 | 404 | 409
 *   DELETE .../teams/:teamId/resources/:resourceType/:resourceId → 204
 *   GET    .../resource-teams?resourceType=&resourceId=   → ResourceTeamRef[]
 *   GET    .../org-chart                   → { organization, teams, agents, members }
 */

export interface TeamResponse {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    parentTeamId: string | null;
    managerAgentId: string | null;
    avatarIcon: string | null;
    organizationId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface OwnerCtx {
    user: Awaited<ReturnType<typeof registerUserViaAPI>>;
    token: string;
    headers: { Authorization: string };
    org: Organization;
    orgId: string;
}

export function teamStamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A fresh user + the org whose creation lazily mints their tenant. */
export async function buildOwnerCtx(
    request: APIRequestContext,
    label = 'Teams',
): Promise<OwnerCtx> {
    const user = await registerUserViaAPI(request);
    const token = user.access_token;
    const org = await createOrganizationViaAPI(request, token, `${label} Org ${teamStamp()}`);
    return { user, token, headers: authedHeaders(token), org, orgId: org.id };
}

export async function createTeamViaAPI(
    request: APIRequestContext,
    ctx: OwnerCtx,
    body: {
        name: string;
        slug?: string;
        description?: string;
        parentTeamId?: string;
        managerAgentId?: string;
        avatarIcon?: string;
    },
): Promise<TeamResponse> {
    const res = await request.post(`${API_BASE}/api/organizations/${ctx.orgId}/teams`, {
        headers: ctx.headers,
        data: body,
    });
    expect(res.status(), `createTeam body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

export function teamsBase(orgId: string): string {
    return `${API_BASE}/api/organizations/${orgId}`;
}
