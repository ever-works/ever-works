import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FleetTaskHandoffOptions } from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { ScopeContextService } from '../../scope/scope-context.service';
import { FleetCheckoutsEnabledGuard } from '../checkouts/fleet-checkouts-enabled.guard';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetSessionsEnabledGuard } from '../sessions/fleet-sessions-enabled.guard';
import { FleetTaskHandoffOptionsQueryDto } from './dto/fleet-task-handoff.dto';
import { FleetTaskHandoffService } from './fleet-task-handoff.service';

/**
 * Tasks on computers (FL-15 P1, CONTRACTS §11.2) — the one read the
 * **Fix with an agent on this computer** dialog opens with. Starting the
 * session is FL-04's `POST /api/fleet/nodes/:id/sessions` with `taskId`: one
 * start path, one start tool (spec FR-21) — there is no `/tasks/:id/handoff`
 * route.
 *
 * Gates, in order: `FleetEnabledGuard`, then `FLEET_SESSIONS_ENABLED` and
 * `FLEET_CHECKOUTS_ENABLED` (the dialog needs both, spec §0; off answers the
 * 404 of an unmounted route), then the session's global auth guard. A Task
 * the person may not see is the 404 `TasksService.getOne` answers.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetSessionsEnabledGuard, FleetCheckoutsEnabledGuard)
export class FleetTaskHandoffController {
    constructor(
        private readonly handoff: FleetTaskHandoffService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get('tasks/:taskId/handoff-options')
    @ApiOperation({
        summary:
            'What “Fix with an agent on this computer” offers for a Task: the Agent candidates Run with agent offers, every computer I may see with why it cannot take the Task, the checkouts of the Task’s repository on each, and the prefilled first message. Reads only — the Agent’s pin is never changed.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async options(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('taskId', ParseUUIDPipe) taskId: string,
        @Query() query: FleetTaskHandoffOptionsQueryDto,
    ): Promise<FleetTaskHandoffOptions> {
        return this.handoff.options(auth.userId, taskId, query.agentId ?? null, this.scopeContext.getScope());
    }
}
