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
import { CreateWorkAgentGoalDto, UpdateWorkAgentPreferencesDto } from './dto/work-agent.dto';

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

    @Get('goals')
    @ApiOperation({ summary: 'List recent Work agent goals' })
    @HttpCode(HttpStatus.OK)
    listGoals(@CurrentUser() auth: AuthenticatedUser) {
        return this.service.listGoals(auth.userId);
    }

    @Post('goals')
    @ApiOperation({ summary: 'Queue a high-level goal for the Work agent' })
    @HttpCode(HttpStatus.ACCEPTED)
    createGoal(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateWorkAgentGoalDto) {
        return this.service.createGoal(auth.userId, body);
    }

    @Patch('goals/:id/cancel')
    @ApiOperation({ summary: 'Cancel a pending or active Work agent goal' })
    @HttpCode(HttpStatus.OK)
    cancelGoal(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.service.cancelGoal(auth.userId, id);
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
