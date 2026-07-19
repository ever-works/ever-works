import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { WorkAgentService } from '@ever-works/agent/work-agent';
import { CreateWorkBuildRequestDto, UpdateWorkAgentPreferencesDto } from './dto/work-agent.dto';

@ApiTags('work-agent')
@Controller('api/me/work-agent')
export class WorkAgentController {
    constructor(private readonly service: WorkAgentService) {}

    @Get('preferences')
    @ApiOperation({ summary: 'Get Work agent preferences and guardrails' })
    @HttpCode(HttpStatus.OK)
    getPreferences(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.getPreferences(auth.userId);
    }

    @Put('preferences')
    @ApiOperation({ summary: 'Update Work agent preferences and guardrails' })
    @HttpCode(HttpStatus.OK)
    updatePreferences(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: UpdateWorkAgentPreferencesDto,
    ) {
        return this.service.updatePreferences(auth.userId, body);
    }

    @Get('build-requests')
    @ApiOperation({ summary: 'List recent Work agent build requests' })
    @HttpCode(HttpStatus.OK)
    listBuildRequests(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.listBuildRequests(auth.userId);
    }

    @Post('build-requests')
    @ApiOperation({ summary: 'Queue a high-level build request for the Work agent' })
    @HttpCode(HttpStatus.ACCEPTED)
    createBuildRequest(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateWorkBuildRequestDto,
    ) {
        return this.service.createBuildRequest(auth.userId, body);
    }

    @Patch('build-requests/:id/cancel')
    @ApiOperation({ summary: 'Cancel a pending or active Work agent build request' })
    @HttpCode(HttpStatus.OK)
    cancelBuildRequest(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.service.cancelBuildRequest(auth.userId, id);
    }

    // ─── DEPRECATED /goals aliases (review §23.3) ────────────────────────
    // "Goal" is reserved for the upcoming measurable-outcome entity; the
    // build-request queue's old routes stay as thin aliases for one release
    // window so existing clients keep working. Remove after the window.

    @Get('goals')
    @ApiOperation({
        deprecated: true,
        summary: 'DEPRECATED alias of build-requests — list recent Work agent build requests',
    })
    @HttpCode(HttpStatus.OK)
    listGoalsDeprecated(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.listBuildRequests(auth.userId);
    }

    @Post('goals')
    @ApiOperation({
        deprecated: true,
        summary: 'DEPRECATED alias of build-requests — queue a Work agent build request',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    createGoalDeprecated(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateWorkBuildRequestDto,
    ) {
        return this.service.createBuildRequest(auth.userId, body);
    }

    @Patch('goals/:id/cancel')
    @ApiOperation({
        deprecated: true,
        summary:
            'DEPRECATED alias of build-requests/:id/cancel — cancel a Work agent build request',
    })
    @HttpCode(HttpStatus.OK)
    cancelGoalDeprecated(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.service.cancelBuildRequest(auth.userId, id);
    }

    @Get('runs/active')
    @ApiOperation({ summary: 'Get the current active Work agent run' })
    @HttpCode(HttpStatus.OK)
    getActiveRun(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.getActiveRun(auth.userId);
    }

    @Get('runs/:id/logs')
    @ApiOperation({ summary: 'List logs for a Work agent run' })
    @HttpCode(HttpStatus.OK)
    listRunLogs(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.service.listRunLogs(auth.userId, id);
    }
}
