'use server';

import { revalidatePath } from 'next/cache';
import { orgMembersAPI, type OrgInvitation, type OrgMember } from '@/lib/api/org-members';

export type InviteResult =
    | { status: 'sent'; invitation: OrgInvitation }
    | { status: 'error'; code: InviteErrorCode };

/**
 * The failures a person inviting a colleague can actually hit. Each needs a
 * different sentence, so they are carried as codes rather than collapsed into
 * one "could not invite".
 */
export type InviteErrorCode =
    | 'invitation_already_pending'
    | 'user_already_a_member'
    | 'user_added_directly'
    | 'invalid_email'
    | 'organization_has_no_tenant'
    | 'unknown';

function classify(error: unknown): InviteErrorCode {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const known: InviteErrorCode[] = [
        'invitation_already_pending',
        'user_already_a_member',
        'user_added_directly',
        'invalid_email',
        'organization_has_no_tenant',
    ];
    return known.find((code) => message.includes(code)) ?? 'unknown';
}

function revalidateOrgSettings(): void {
    revalidatePath('/settings/organization');
}

export async function inviteToOrganizationAction(
    orgId: string,
    email: string,
    invitedName?: string,
): Promise<InviteResult> {
    try {
        const invitation = await orgMembersAPI.invite(orgId, email, invitedName);
        revalidateOrgSettings();
        return { status: 'sent', invitation };
    } catch (error) {
        // `user_added_directly` is a SUCCESS the API reports as a 400: the
        // person was already in the tenant, so they were put on the roster
        // instead of being mailed a token they did not need. Revalidate so
        // the new roster row appears.
        const code = classify(error);
        if (code === 'user_added_directly') {
            revalidateOrgSettings();
        }
        return { status: 'error', code };
    }
}

export async function revokeOrgInvitationAction(
    orgId: string,
    invitationId: string,
): Promise<void> {
    await orgMembersAPI.revokeInvitation(orgId, invitationId);
    revalidateOrgSettings();
}

export async function removeOrgMemberAction(orgId: string, userId: string): Promise<void> {
    await orgMembersAPI.removeMember(orgId, userId);
    revalidateOrgSettings();
}

export async function listOrgMembersAction(orgId: string): Promise<{
    members: OrgMember[];
    invitations: OrgInvitation[];
}> {
    const [members, invitations] = await Promise.all([
        orgMembersAPI.listMembers(orgId),
        orgMembersAPI.listInvitations(orgId),
    ]);
    return { members, invitations };
}
