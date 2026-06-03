'use server';

import { revalidatePath } from 'next/cache';
import {
    invitationsAPI,
    type CreateInvitationDto,
    type CreateInvitationResponse,
    type WorkInvitation,
} from '@/lib/api/invitations';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function listInvitations(workId: string): Promise<ActionResult<WorkInvitation[]>> {
    try {
        const res = await invitationsAPI.list(workId);
        return { ok: true, data: res.invitations };
    } catch (err) {
        // Security: log full error server-side only; return generic message to avoid info-leak
        console.error('[invitations] listInvitations error:', err);
        return {
            ok: false,
            error: 'Failed to load invitations. Please try again.',
        };
    }
}

export async function createInvitation(
    workId: string,
    dto: CreateInvitationDto,
): Promise<ActionResult<CreateInvitationResponse>> {
    try {
        const res = await invitationsAPI.create(workId, dto);
        revalidatePath(`/works/${workId}/settings/members`);
        return { ok: true, data: res as unknown as CreateInvitationResponse };
    } catch (err) {
        // Security: log full error server-side only; return generic message to avoid info-leak
        console.error('[invitations] createInvitation error:', err);
        return {
            ok: false,
            error: 'Failed to send invitation. Please try again.',
        };
    }
}

export async function revokeInvitation(
    workId: string,
    invitationId: string,
): Promise<ActionResult<true>> {
    try {
        await invitationsAPI.revoke(workId, invitationId);
        revalidatePath(`/works/${workId}/settings/members`);
        return { ok: true, data: true };
    } catch (err) {
        // Security: log full error server-side only; return generic message to avoid info-leak
        console.error('[invitations] revokeInvitation error:', err);
        return {
            ok: false,
            error: 'Failed to revoke invitation. Please try again.',
        };
    }
}
