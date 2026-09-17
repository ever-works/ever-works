import { BadRequestException, Controller, Get, Header, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HomeSummaryService, InvalidHomeTimezoneError } from '@ever-works/agent/home';
import type { HomeSummaryDto } from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';
import { HomeSummaryQueryDto } from './dto/home-summary-query.dto';

/**
 * Home (AW-19) — the composed morning read behind the dashboard root.
 *
 * Read-only: one response carrying every block with its own status, built
 * from surfaces that already own the data (My Decisions, the Runs ledger,
 * the schedule aggregation, the Costs summary, the Live Feed). A block that
 * fails is reported inside a 200; only an invalid request is an HTTP error.
 *
 * **Security — no caller-supplied subject.** There is no user id and no
 * organization id parameter. The owner is the authenticated session
 * (`@CurrentUser()`) and the scope is the request scope context, so a caller
 * can never read another user's morning, and anything outside the scope is
 * simply absent. The response is `private, no-store`: spend and decisions
 * must never sit in a shared cache.
 *
 * Authentication is the global `AuthSessionGuard`.
 */
@ApiTags('Home')
@ApiBearerAuth('JWT-auth')
@Controller('api/home')
export class HomeController {
    constructor(
        private readonly home: HomeSummaryService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get('summary')
    @Header('Cache-Control', 'private, no-store')
    @ApiOperation({
        summary: 'Read the Home morning summary',
        description:
            'Every block of the morning read — decisions waiting, today at a glance, today’s schedules, the last 7 days of spend beside the account-wide cap, the runs working now and the recent activity — each with an ok/failed status.',
    })
    @ApiResponse({ status: 200, description: 'The summary; failed blocks are reported inside it.' })
    @ApiResponse({ status: 400, description: 'An unknown timezone or block id.' })
    @ApiResponse({ status: 401, description: 'No session.' })
    async getSummary(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: HomeSummaryQueryDto,
    ): Promise<HomeSummaryDto> {
        try {
            return await this.home.build(auth.userId, {
                scope: this.scopeContext.getScope(),
                timezone: query.tz,
                blocks: query.blocks,
            });
        } catch (error) {
            if (error instanceof InvalidHomeTimezoneError) {
                throw new BadRequestException({ error: error.code, message: error.message });
            }
            throw error;
        }
    }
}
