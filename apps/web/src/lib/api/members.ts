import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { WorkMemberRole, ASSIGNABLE_MEMBER_ROLES } from './enums';
import { APIResponse } from './types';

export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];

export interface WorkMember {
    id: string;
    userId: string;
    username: string;
    email: string;
    avatar?: string;
    role: WorkMemberRole;
    invitedBy?: {
        id: string;
        username: string;
    };
    createdAt: string;
}

export interface WorkOwner {
    id: string;
    username: string;
    email: string;
    avatar?: string;
}

export interface MembersListResponse {
    members: WorkMember[];
    owner: WorkOwner;
}

export interface InviteMemberDto {
    email: string;
    role: AssignableMemberRole;
}

export interface UpdateMemberRoleDto {
    role: AssignableMemberRole;
}

export const membersAPI = {
    list: async (workId: string) => {
        return serverFetch<APIResponse<MembersListResponse>>(`/works/${workId}/members`);
    },

    invite: async (workId: string, data: InviteMemberDto) => {
        return serverMutation<APIResponse<{ member: WorkMember }>>({
            endpoint: `/works/${workId}/members`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    get: async (workId: string, memberId: string) => {
        return serverFetch<APIResponse<{ member: WorkMember }>>(
            `/works/${workId}/members/${memberId}`,
        );
    },

    updateRole: async (workId: string, memberId: string, data: UpdateMemberRoleDto) => {
        return serverMutation<APIResponse<{ member: WorkMember }>>({
            endpoint: `/works/${workId}/members/${memberId}`,
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    remove: async (workId: string, memberId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/works/${workId}/members/${memberId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    leave: async (workId: string) => {
        return serverMutation<APIResponse<{ message: string }>>({
            endpoint: `/works/${workId}/members/leave`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
