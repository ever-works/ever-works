import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { DirectoryMemberRole } from './enums';
import { APIResponse } from './types';

export interface DirectoryMember {
    id: string;
    userId: string;
    username: string;
    email: string;
    avatar?: string;
    role: DirectoryMemberRole;
    invitedBy?: {
        id: string;
        username: string;
    };
    createdAt: string;
}

export interface DirectoryOwner {
    id: string;
    username: string;
    email: string;
    avatar?: string;
}

export interface MembersListResponse {
    members: DirectoryMember[];
    owner: DirectoryOwner;
}

export interface InviteMemberDto {
    email: string;
    role: DirectoryMemberRole;
}

export interface UpdateMemberRoleDto {
    role: DirectoryMemberRole;
}

export const membersAPI = {
    list: async (directoryId: string) => {
        return serverFetch<APIResponse<MembersListResponse>>(`/directories/${directoryId}/members`);
    },

    invite: async (directoryId: string, data: InviteMemberDto) => {
        return serverMutation<APIResponse<{ member: DirectoryMember }>>({
            endpoint: `/directories/${directoryId}/members`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    get: async (directoryId: string, memberId: string) => {
        return serverFetch<APIResponse<{ member: DirectoryMember }>>(
            `/directories/${directoryId}/members/${memberId}`,
        );
    },

    updateRole: async (directoryId: string, memberId: string, data: UpdateMemberRoleDto) => {
        return serverMutation<APIResponse<{ member: DirectoryMember }>>({
            endpoint: `/directories/${directoryId}/members/${memberId}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    remove: async (directoryId: string, memberId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/directories/${directoryId}/members/${memberId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    leave: async (directoryId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/directories/${directoryId}/members/leave`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
