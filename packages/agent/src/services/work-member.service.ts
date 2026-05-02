import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { WorkMemberRepository } from '@src/database/repositories/work-member.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { WorkOwnershipService } from './work-ownership.service';
import { WorkMember } from '@src/entities/work-member.entity';
import { WorkMemberRole, ASSIGNABLE_MEMBER_ROLES } from '@src/entities/types';
import { User } from '@src/entities/user.entity';
import type { Work } from '@src/entities';

export interface WorkMemberDto {
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

export interface InviteMemberDto {
    email: string;
    role: WorkMemberRole;
}

export interface UpdateMemberRoleDto {
    role: WorkMemberRole;
}

export interface InviteMemberResult {
    member: WorkMemberDto;
    invitee: User;
    inviter: User;
    work: Work;
}

@Injectable()
export class WorkMemberService {
    constructor(
        private readonly memberRepository: WorkMemberRepository,
        private readonly userRepository: UserRepository,
        private readonly ownershipService: WorkOwnershipService,
    ) {}

    async listMembers(workId: string, userId: string): Promise<WorkMemberDto[]> {
        await this.ownershipService.ensureCanView(workId, userId);

        const members = await this.memberRepository.findByWork(workId);
        return members.map((member) => this.toDto(member));
    }

    async inviteMember(
        workId: string,
        userId: string,
        dto: InviteMemberDto,
    ): Promise<InviteMemberResult> {
        const { work } = await this.ownershipService.ensureCanManageMembers(
            workId,
            userId,
        );

        if (
            !ASSIGNABLE_MEMBER_ROLES.includes(dto.role as (typeof ASSIGNABLE_MEMBER_ROLES)[number])
        ) {
            throw new BadRequestException({
                status: 'error',
                message: 'Invalid role. Members can only be assigned: viewer, editor, or manager',
            });
        }

        const invitee = await this.userRepository.findByEmail(dto.email);
        if (!invitee) {
            throw new NotFoundException({
                status: 'error',
                message: `User with email '${dto.email}' not found`,
            });
        }

        if (invitee.id === work.userId) {
            throw new BadRequestException({
                status: 'error',
                message: 'Cannot add the work creator as a member',
            });
        }

        const existingMember = await this.memberRepository.findMember(workId, invitee.id);
        if (existingMember) {
            throw new BadRequestException({
                status: 'error',
                message: 'User is already a member of this work',
            });
        }

        const inviter = await this.userRepository.findById(userId);

        const member = await this.memberRepository.addMember(
            workId,
            invitee.id,
            dto.role,
            userId,
        );

        const memberWithRelations = await this.memberRepository.findById(member.id);
        return {
            member: this.toDto(memberWithRelations!),
            invitee,
            inviter: inviter!,
            work,
        };
    }

    async updateMemberRole(
        workId: string,
        userId: string,
        memberId: string,
        dto: UpdateMemberRoleDto,
    ): Promise<WorkMemberDto> {
        await this.ownershipService.ensureCanManageMembers(workId, userId);

        const member = await this.memberRepository.findById(memberId);
        if (!member || member.workId !== workId) {
            throw new NotFoundException({
                status: 'error',
                message: 'Member not found',
            });
        }

        if (
            !ASSIGNABLE_MEMBER_ROLES.includes(dto.role as (typeof ASSIGNABLE_MEMBER_ROLES)[number])
        ) {
            throw new BadRequestException({
                status: 'error',
                message: 'Invalid role. Members can only be assigned: viewer, editor, or manager',
            });
        }

        const updated = await this.memberRepository.updateRole(
            workId,
            member.userId,
            dto.role,
        );
        return this.toDto(updated!);
    }

    async removeMember(workId: string, userId: string, memberId: string): Promise<void> {
        await this.ownershipService.ensureCanManageMembers(workId, userId);

        const member = await this.memberRepository.findById(memberId);
        if (!member || member.workId !== workId) {
            throw new NotFoundException({
                status: 'error',
                message: 'Member not found',
            });
        }

        await this.memberRepository.removeMember(workId, member.userId);
    }

    async leaveWork(workId: string, userId: string): Promise<void> {
        const { isCreator } = await this.ownershipService.ensureCanView(workId, userId);

        if (isCreator) {
            throw new BadRequestException({
                status: 'error',
                message: 'Work creator cannot leave the work',
            });
        }

        const removed = await this.memberRepository.removeMember(workId, userId);
        if (!removed) {
            throw new NotFoundException({
                status: 'error',
                message: 'You are not a member of this work',
            });
        }
    }

    async getMember(
        workId: string,
        userId: string,
        memberId: string,
    ): Promise<WorkMemberDto> {
        await this.ownershipService.ensureCanView(workId, userId);

        const member = await this.memberRepository.findById(memberId);
        if (!member || member.workId !== workId) {
            throw new NotFoundException({
                status: 'error',
                message: 'Member not found',
            });
        }

        return this.toDto(member);
    }

    async getWorkOwnerInfo(
        workId: string,
        userId: string,
    ): Promise<{ id: string; username: string; email: string; avatar?: string }> {
        const { work } = await this.ownershipService.ensureCanView(workId, userId);
        const owner = work.user as User;

        return {
            id: owner.id,
            username: owner.username,
            email: owner.email,
            avatar: owner.avatar,
        };
    }

    private toDto(member: WorkMember): WorkMemberDto {
        const user = member.user as User;
        const invitedBy = member.invitedBy as User | undefined;

        return {
            id: member.id,
            userId: member.userId,
            username: user?.username || 'Unknown',
            email: user?.email || '',
            avatar: user?.avatar,
            role: member.role,
            invitedBy: invitedBy
                ? {
                      id: invitedBy.id,
                      username: invitedBy.username,
                  }
                : undefined,
            createdAt: member.createdAt.toISOString(),
        };
    }
}
