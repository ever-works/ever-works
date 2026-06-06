'use server';

import { membersAPI, WorkMember, AssignableMemberRole } from '@/lib/api';
import { revalidatePath } from 'next/cache';
// Security: server actions are reachable as POST endpoints via the
// `Next-Action` header, so every exported action must independently verify
// authentication at the Next.js layer before proxying to backend
// membership-mutation endpoints — UI gating alone is not a security boundary.
// Mirrors works.ts / work-proposals.ts / items.ts.
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { redirect } from 'next/navigation';

interface ActionResult {
    status: 'success' | 'error';
    message?: string;
    member?: WorkMember;
}

export async function inviteMember(
    workId: string,
    email: string,
    role: AssignableMemberRole,
): Promise<ActionResult> {
    // Security: independently verify authentication before any membership mutation.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await membersAPI.invite(workId, { email, role });

        if (result.status === 'success') {
            revalidatePath(`/works/${workId}/members`);
            return { status: 'success', member: result.member };
        }

        return { status: 'error', message: 'Failed to invite member' };
    } catch (error: any) {
        return {
            status: 'error',
            message: error?.message || 'Failed to invite member',
        };
    }
}

export async function updateMemberRole(
    workId: string,
    memberId: string,
    role: AssignableMemberRole,
): Promise<ActionResult> {
    // Security: independently verify authentication before any membership mutation.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await membersAPI.updateRole(workId, memberId, { role });

        if (result.status === 'success') {
            revalidatePath(`/works/${workId}/members`);
            return { status: 'success', member: result.member };
        }

        return { status: 'error', message: 'Failed to update member role' };
    } catch (error: any) {
        return {
            status: 'error',
            message: error?.message || 'Failed to update member role',
        };
    }
}

export async function removeMember(workId: string, memberId: string): Promise<ActionResult> {
    // Security: independently verify authentication before any membership mutation.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await membersAPI.remove(workId, memberId);

        if (result.status === 'success') {
            revalidatePath(`/works/${workId}/members`);
            return { status: 'success' };
        }

        return { status: 'error', message: 'Failed to remove member' };
    } catch (error: any) {
        return {
            status: 'error',
            message: error?.message || 'Failed to remove member',
        };
    }
}

export async function leaveWork(workId: string): Promise<ActionResult> {
    // Security: independently verify authentication before any membership mutation.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await membersAPI.leave(workId);

        if (result.status === 'success') {
            revalidatePath('/works');
            return { status: 'success' };
        }

        return { status: 'error', message: 'Failed to leave work' };
    } catch (error: any) {
        return {
            status: 'error',
            message: error?.message || 'Failed to leave work',
        };
    }
}
