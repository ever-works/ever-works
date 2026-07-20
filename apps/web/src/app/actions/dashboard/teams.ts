'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
    teamsAPI,
    type CreateTeamInput,
    type TeamMemberRole,
    type TeamMemberType,
    type TeamResourceType,
    type UpdateTeamInput,
} from '@/lib/api/teams';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * Teams & Prebuilt Companies — web server actions
 * (`docs/specs/features/teams-and-companies/spec.md` §4.2). Defense-in-depth
 * auth guard at the web layer (missions.ts pattern); real authorization is
 * the API's `OrganizationOwnershipGuard`.
 */
async function requireTeamsAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

const TEAM_REVALIDATE_PATHS = [
    '/[locale]/(dashboard)/teams',
    '/[locale]/(dashboard)/teams/[id]',
    '/[locale]/(dashboard)/teams/org-chart',
];
function revalidateTeamSurfaces() {
    for (const p of TEAM_REVALIDATE_PATHS) {
        revalidatePath(p, 'page');
    }
}

export async function createTeamAction(orgId: string, input: CreateTeamInput) {
    await requireTeamsAuth();
    const team = await teamsAPI.create(orgId, input);
    revalidateTeamSurfaces();
    return team;
}

export async function updateTeamAction(orgId: string, teamId: string, input: UpdateTeamInput) {
    await requireTeamsAuth();
    const team = await teamsAPI.update(orgId, teamId, input);
    revalidateTeamSurfaces();
    return team;
}

export async function deleteTeamAction(orgId: string, teamId: string) {
    await requireTeamsAuth();
    await teamsAPI.remove(orgId, teamId);
    revalidateTeamSurfaces();
}

export async function addTeamMemberAction(
    orgId: string,
    teamId: string,
    input: { memberType: TeamMemberType; memberId: string; role?: TeamMemberRole },
) {
    await requireTeamsAuth();
    const member = await teamsAPI.addMember(orgId, teamId, input);
    revalidateTeamSurfaces();
    return member;
}

export async function removeTeamMemberAction(
    orgId: string,
    teamId: string,
    memberType: TeamMemberType,
    memberId: string,
) {
    await requireTeamsAuth();
    await teamsAPI.removeMember(orgId, teamId, memberType, memberId);
    revalidateTeamSurfaces();
}

export async function attachTeamResourceAction(
    orgId: string,
    teamId: string,
    input: { resourceType: TeamResourceType; resourceId: string },
) {
    await requireTeamsAuth();
    const resource = await teamsAPI.attachResource(orgId, teamId, input);
    revalidateTeamSurfaces();
    return resource;
}

export async function detachTeamResourceAction(
    orgId: string,
    teamId: string,
    resourceType: TeamResourceType,
    resourceId: string,
) {
    await requireTeamsAuth();
    await teamsAPI.detachResource(orgId, teamId, resourceType, resourceId);
    revalidateTeamSurfaces();
}
