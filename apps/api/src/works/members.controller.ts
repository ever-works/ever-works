import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Put,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkMemberService } from '@ever-works/agent/services';
import { AuthService, CurrentUser, AuthSessionGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { MemberInvitedEvent } from '../events';
import { config } from '../config/constants';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';

@ApiTags('Members')
@ApiBearerAuth('JWT-auth')
@Controller('api/works/:workId/members')
@UseGuards(AuthSessionGuard)
export class MembersController {
    constructor(
        private readonly memberService: WorkMemberService,
        private readonly authService: AuthService,
        private readonly eventEmitter: EventEmitter2,
        private readonly activityLogService: ActivityLogService,
    ) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List members', description: 'Get all members of a work' })
    @ApiResponse({ status: 200, description: 'List of work members' })
    async listMembers(@CurrentUser() auth: AuthenticatedUser, @Param('workId') workId: string) {
        const user = await this.authService.getUser(auth.userId);
        const members = await this.memberService.listMembers(workId, user.id);
        const owner = await this.memberService.getWorkOwnerInfo(workId, user.id);

        return {
            status: 'success',
            members,
            owner,
        };
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Invite member', description: 'Invite a user to join the work' })
    @ApiResponse({ status: 201, description: 'Member invited successfully' })
    async inviteMember(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Body() dto: InviteMemberDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.memberService.inviteMember(workId, user.id, dto);

        const workUrl = `${config.webAppUrl()}/works/${workId}`;
        this.eventEmitter.emit(
            MemberInvitedEvent.EVENT_NAME,
            new MemberInvitedEvent(result.invitee, result.inviter, result.work, dto.role, workUrl),
        );

        return {
            status: 'success',
            member: result.member,
        };
    }

    @Get(':memberId')
    @HttpCode(HttpStatus.OK)
    async getMember(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Param('memberId') memberId: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const member = await this.memberService.getMember(workId, user.id, memberId);

        return {
            status: 'success',
            member,
        };
    }

    @Put(':memberId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update member role',
        description: 'Update the role of a work member',
    })
    @ApiResponse({ status: 200, description: 'Member role updated' })
    async updateMemberRole(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Param('memberId') memberId: string,
        @Body() dto: UpdateMemberRoleDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const member = await this.memberService.updateMemberRole(workId, user.id, memberId, dto);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.MEMBER_ROLE_CHANGED,
                action: 'member.role_changed',
                status: ActivityStatus.COMPLETED,
                summary: `Changed member role to ${dto.role}`,
                details: { memberId, role: dto.role },
            })
            .catch(() => {});

        return {
            status: 'success',
            member,
        };
    }

    @Delete(':memberId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Remove member', description: 'Remove a member from the work' })
    @ApiResponse({ status: 200, description: 'Member removed successfully' })
    async removeMember(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Param('memberId') memberId: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.memberService.removeMember(workId, user.id, memberId);

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.MEMBER_REMOVED,
                action: 'member.removed',
                status: ActivityStatus.COMPLETED,
                summary: `Removed member from work`,
                details: { memberId },
            })
            .catch(() => {});

        return {
            status: 'success',
            message: 'Member removed successfully',
        };
    }

    @Post('leave')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Leave work',
        description: 'Leave a work you are a member of',
    })
    @ApiResponse({ status: 200, description: 'Successfully left the work' })
    async leaveWork(@CurrentUser() auth: AuthenticatedUser, @Param('workId') workId: string) {
        const user = await this.authService.getUser(auth.userId);
        await this.memberService.leaveWork(workId, user.id);

        return {
            status: 'success',
            message: 'Successfully left the work',
        };
    }
}
