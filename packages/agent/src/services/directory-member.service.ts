import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { DirectoryMemberRepository } from '@src/database/repositories/directory-member.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { DirectoryMember } from '@src/entities/directory-member.entity';
import { DirectoryMemberRole } from '@src/entities/types';
import { User } from '@src/entities/user.entity';
import type { Directory } from '@src/entities';

export interface DirectoryMemberDto {
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

export interface InviteMemberDto {
    email: string;
    role: DirectoryMemberRole;
}

export interface UpdateMemberRoleDto {
    role: DirectoryMemberRole;
}

export interface InviteMemberResult {
    member: DirectoryMemberDto;
    invitee: User;
    inviter: User;
    directory: Directory;
}

@Injectable()
export class DirectoryMemberService {
    constructor(
        private readonly memberRepository: DirectoryMemberRepository,
        private readonly userRepository: UserRepository,
        private readonly ownershipService: DirectoryOwnershipService,
    ) {}

    async listMembers(directoryId: string, userId: string): Promise<DirectoryMemberDto[]> {
        await this.ownershipService.ensureCanView(directoryId, userId);

        const members = await this.memberRepository.findByDirectory(directoryId);
        return members.map((member) => this.toDto(member));
    }

    async inviteMember(
        directoryId: string,
        userId: string,
        dto: InviteMemberDto,
    ): Promise<InviteMemberResult> {
        const { directory, isCreator } = await this.ownershipService.ensureCanManageMembers(
            directoryId,
            userId,
        );

        if (dto.role === DirectoryMemberRole.OWNER && !isCreator) {
            throw new ForbiddenException({
                status: 'error',
                message: 'Only the directory creator can assign owner role',
            });
        }

        const invitee = await this.userRepository.findByEmail(dto.email);
        if (!invitee) {
            throw new NotFoundException({
                status: 'error',
                message: `User with email '${dto.email}' not found`,
            });
        }

        if (invitee.id === directory.userId) {
            throw new BadRequestException({
                status: 'error',
                message: 'Cannot add the directory creator as a member',
            });
        }

        const existingMember = await this.memberRepository.findMember(directoryId, invitee.id);
        if (existingMember) {
            throw new BadRequestException({
                status: 'error',
                message: 'User is already a member of this directory',
            });
        }

        const inviter = await this.userRepository.findById(userId);

        const member = await this.memberRepository.addMember(
            directoryId,
            invitee.id,
            dto.role,
            userId,
        );

        const memberWithRelations = await this.memberRepository.findById(member.id);
        return {
            member: this.toDto(memberWithRelations!),
            invitee,
            inviter: inviter!,
            directory,
        };
    }

    async updateMemberRole(
        directoryId: string,
        userId: string,
        memberId: string,
        dto: UpdateMemberRoleDto,
    ): Promise<DirectoryMemberDto> {
        const { isCreator } = await this.ownershipService.ensureCanManageMembers(
            directoryId,
            userId,
        );

        const member = await this.memberRepository.findById(memberId);
        if (!member || member.directoryId !== directoryId) {
            throw new NotFoundException({
                status: 'error',
                message: 'Member not found',
            });
        }

        if (dto.role === DirectoryMemberRole.OWNER && !isCreator) {
            throw new ForbiddenException({
                status: 'error',
                message: 'Only the directory creator can assign owner role',
            });
        }

        if (member.role === DirectoryMemberRole.OWNER && !isCreator) {
            throw new ForbiddenException({
                status: 'error',
                message: 'Only the directory creator can modify an owner',
            });
        }

        const updated = await this.memberRepository.updateRole(
            directoryId,
            member.userId,
            dto.role,
        );
        return this.toDto(updated!);
    }

    async removeMember(directoryId: string, userId: string, memberId: string): Promise<void> {
        const { isCreator } = await this.ownershipService.ensureCanManageMembers(
            directoryId,
            userId,
        );

        const member = await this.memberRepository.findById(memberId);
        if (!member || member.directoryId !== directoryId) {
            throw new NotFoundException({
                status: 'error',
                message: 'Member not found',
            });
        }

        if (member.role === DirectoryMemberRole.OWNER && !isCreator) {
            throw new ForbiddenException({
                status: 'error',
                message: 'Only the directory creator can remove an owner',
            });
        }

        await this.memberRepository.removeMember(directoryId, member.userId);
    }

    async leaveDirectory(directoryId: string, userId: string): Promise<void> {
        const { isCreator } = await this.ownershipService.ensureCanView(directoryId, userId);

        if (isCreator) {
            throw new BadRequestException({
                status: 'error',
                message: 'Directory creator cannot leave the directory',
            });
        }

        const removed = await this.memberRepository.removeMember(directoryId, userId);
        if (!removed) {
            throw new NotFoundException({
                status: 'error',
                message: 'You are not a member of this directory',
            });
        }
    }

    async getMember(
        directoryId: string,
        userId: string,
        memberId: string,
    ): Promise<DirectoryMemberDto> {
        await this.ownershipService.ensureCanView(directoryId, userId);

        const member = await this.memberRepository.findById(memberId);
        if (!member || member.directoryId !== directoryId) {
            throw new NotFoundException({
                status: 'error',
                message: 'Member not found',
            });
        }

        return this.toDto(member);
    }

    async getDirectoryOwnerInfo(
        directoryId: string,
        userId: string,
    ): Promise<{ id: string; username: string; email: string; avatar?: string }> {
        const { directory } = await this.ownershipService.ensureCanView(directoryId, userId);
        const owner = directory.user as User;

        return {
            id: owner.id,
            username: owner.username,
            email: owner.email,
            avatar: owner.avatar,
        };
    }

    private toDto(member: DirectoryMember): DirectoryMemberDto {
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
