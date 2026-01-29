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
import { DirectoryMemberService } from '@packages/agent/services';
import { AuthService, CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { MemberInvitedEvent } from '../events';
import { config } from '../config/constants';

@ApiTags('Members')
@ApiBearerAuth('JWT-auth')
@Controller('api/directories/:directoryId/members')
@UseGuards(JwtAuthGuard)
export class MembersController {
    constructor(
        private readonly memberService: DirectoryMemberService,
        private readonly authService: AuthService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List members', description: 'Get all members of a directory' })
    @ApiResponse({ status: 200, description: 'List of directory members' })
    async listMembers(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const members = await this.memberService.listMembers(directoryId, user.id);
        const owner = await this.memberService.getDirectoryOwnerInfo(directoryId, user.id);

        return {
            status: 'success',
            members,
            owner,
        };
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Invite member', description: 'Invite a user to join the directory' })
    @ApiResponse({ status: 201, description: 'Member invited successfully' })
    async inviteMember(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
        @Body() dto: InviteMemberDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const result = await this.memberService.inviteMember(directoryId, user.id, dto);

        const directoryUrl = `${config.webAppUrl()}/directories/${directoryId}`;
        this.eventEmitter.emit(
            MemberInvitedEvent.EVENT_NAME,
            new MemberInvitedEvent(
                result.invitee,
                result.inviter,
                result.directory,
                dto.role,
                directoryUrl,
            ),
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
        @Param('directoryId') directoryId: string,
        @Param('memberId') memberId: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const member = await this.memberService.getMember(directoryId, user.id, memberId);

        return {
            status: 'success',
            member,
        };
    }

    @Put(':memberId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Update member role',
        description: 'Update the role of a directory member',
    })
    @ApiResponse({ status: 200, description: 'Member role updated' })
    async updateMemberRole(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
        @Param('memberId') memberId: string,
        @Body() dto: UpdateMemberRoleDto,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const member = await this.memberService.updateMemberRole(
            directoryId,
            user.id,
            memberId,
            dto,
        );

        return {
            status: 'success',
            member,
        };
    }

    @Delete(':memberId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Remove member', description: 'Remove a member from the directory' })
    @ApiResponse({ status: 200, description: 'Member removed successfully' })
    async removeMember(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
        @Param('memberId') memberId: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.memberService.removeMember(directoryId, user.id, memberId);

        return {
            status: 'success',
            message: 'Member removed successfully',
        };
    }

    @Post('leave')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Leave directory',
        description: 'Leave a directory you are a member of',
    })
    @ApiResponse({ status: 200, description: 'Successfully left the directory' })
    async leaveDirectory(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('directoryId') directoryId: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        await this.memberService.leaveDirectory(directoryId, user.id);

        return {
            status: 'success',
            message: 'Successfully left the directory',
        };
    }
}
