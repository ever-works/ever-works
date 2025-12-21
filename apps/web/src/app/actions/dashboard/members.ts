'use server';

import { membersAPI, DirectoryMember, AssignableMemberRole } from '@/lib/api';
import { revalidatePath } from 'next/cache';

interface ActionResult {
    status: 'success' | 'error';
    message?: string;
    member?: DirectoryMember;
}

export async function inviteMember(
    directoryId: string,
    email: string,
    role: AssignableMemberRole,
): Promise<ActionResult> {
    try {
        const result = await membersAPI.invite(directoryId, { email, role });

        if (result.status === 'success') {
            revalidatePath(`/directories/${directoryId}/members`);
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
    directoryId: string,
    memberId: string,
    role: AssignableMemberRole,
): Promise<ActionResult> {
    try {
        const result = await membersAPI.updateRole(directoryId, memberId, { role });

        if (result.status === 'success') {
            revalidatePath(`/directories/${directoryId}/members`);
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

export async function removeMember(directoryId: string, memberId: string): Promise<ActionResult> {
    try {
        const result = await membersAPI.remove(directoryId, memberId);

        if (result.status === 'success') {
            revalidatePath(`/directories/${directoryId}/members`);
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

export async function leaveDirectory(directoryId: string): Promise<ActionResult> {
    try {
        const result = await membersAPI.leave(directoryId);

        if (result.status === 'success') {
            revalidatePath('/directories');
            return { status: 'success' };
        }

        return { status: 'error', message: 'Failed to leave directory' };
    } catch (error: any) {
        return {
            status: 'error',
            message: error?.message || 'Failed to leave directory',
        };
    }
}
