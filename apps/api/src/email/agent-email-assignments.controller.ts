import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    AgentEmailAssignmentsService,
    CreateAgentEmailAssignmentDto,
} from './agent-email-assignments.service';

/**
 * Agent email (AW-05) — assign one of your email addresses to an Agent.
 *
 *   GET    /api/email/agents/:agentId/assignments
 *   POST   /api/email/agents/:agentId/assignments
 *   DELETE /api/email/assignments/:id
 *
 * An outbound assignment is what the Agent's `sendEmail` tool and the
 * inbox composer send from; an inbound one is where mail reaches it.
 */
@ApiTags('Email')
@Controller('api/email')
@UseGuards(AuthSessionGuard)
@ApiBearerAuth('JWT-auth')
export class AgentEmailAssignmentsController {
    constructor(private readonly assignments: AgentEmailAssignmentsService) {}

    @Get('agents/:agentId/assignments')
    @ApiOperation({ summary: 'List the email addresses assigned to an Agent' })
    async list(@CurrentUser() auth: AuthenticatedUser, @Param('agentId') agentId: string) {
        return { assignments: await this.assignments.list(auth.userId, agentId) };
    }

    @Post('agents/:agentId/assignments')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Assign one of your email addresses to an Agent' })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId') agentId: string,
        @Body() body: CreateAgentEmailAssignmentDto,
    ) {
        return { assignment: await this.assignments.create(auth.userId, agentId, body) };
    }

    @Delete('assignments/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Remove an email address assignment from an Agent' })
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        await this.assignments.remove(auth.userId, id);
    }
}
