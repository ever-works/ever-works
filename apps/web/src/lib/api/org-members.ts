import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export interface OrgMember {
    id: string;
    userId: string;
    role: string;
    invitedById: string | null;
    joinedAt: string;
}

export interface OrgInvitation {
    id: string;
    email: string;
    role: string;
    /** 'pending' | 'accepted' | 'expired' | 'revoked' */
    status: string;
    invitedById: string;
    tokenExpiresAt: string;
    acceptedAt: string | null;
    createdAt: string;
}

/**
 * Organization roster + invitation management.
 *
 * 🛑 Nothing here ever carries a token: the API deliberately omits it from
 * every response, including to the issuer. The only copy that exists outside
 * the `sha256` in the database is the one in the email body.
 *
 * Reads swallow failures to `[]`, matching `teamsAPI.listOrganizations` —
 * these feed a settings panel whose other sections must still render. Writes
 * do NOT swallow: the caller needs to tell the user whether the invitation
 * was actually sent.
 */
export const orgMembersAPI = {
    async listMembers(orgId: string): Promise<OrgMember[]> {
        try {
            return await serverFetch<OrgMember[]>(`/organizations/${orgId}/members`, {
                method: 'GET',
            });
        } catch {
            return [];
        }
    },

    async listInvitations(orgId: string): Promise<OrgInvitation[]> {
        try {
            return await serverFetch<OrgInvitation[]>(`/organizations/${orgId}/invitations`, {
                method: 'GET',
            });
        } catch {
            return [];
        }
    },

    async invite(orgId: string, email: string, invitedName?: string): Promise<OrgInvitation> {
        return serverMutation<OrgInvitation>({
            endpoint: `/organizations/${orgId}/invitations`,
            method: 'POST',
            data: invitedName ? { email, invitedName } : { email },
            wrapInData: false,
        });
    },

    async revokeInvitation(orgId: string, invitationId: string): Promise<void> {
        await serverMutation<void>({
            endpoint: `/organizations/${orgId}/invitations/${invitationId}`,
            method: 'DELETE',
            data: {},
            wrapInData: false,
        });
    },

    async removeMember(orgId: string, userId: string): Promise<void> {
        await serverMutation<void>({
            endpoint: `/organizations/${orgId}/members/${userId}`,
            method: 'DELETE',
            data: {},
            wrapInData: false,
        });
    },
};
