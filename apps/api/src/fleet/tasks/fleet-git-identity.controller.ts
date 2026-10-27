import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetGitIdentityService } from '@ever-works/agent/fleet';
import {
    FLEET_GIT_IDENTITY_PER_MINUTE,
    type FleetGitIdentity,
    type FleetGitIdentitySetResult,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetCheckoutsEnabledGuard } from '../checkouts/fleet-checkouts-enabled.guard';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetGitIdentityQueryDto, SetFleetGitIdentityDto } from './dto/fleet-git-identity.dto';
import { FleetConfirmationInterceptor } from '../tools/fleet-confirmation.interceptor';

/**
 * Tasks on computers (FL-15 P2, CONTRACTS §11.2 `/nodes/:id/git/identity`) —
 * a computer's global git identity: read (the `view` family; the values only
 * for the computer's owner, FR-13) and **Use my Ever Works identity** (the
 * `commands` family, class `confirm`, the owner's own computer only, audited
 * `node.git.identity.set` with the field names — FR-14, FR-15).
 *
 * Gates: `FleetEnabledGuard`, then `FLEET_CHECKOUTS_ENABLED` (FL-15's flag,
 * CONTRACTS §9; off answers the 404 of an unmounted route), then the
 * session's global auth guard, then the link's own gate inside the service
 * (existence, kill switch, `--manage`, the family audience). Every refusal is
 * the CONTRACTS §8 envelope with its status.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetCheckoutsEnabledGuard)
// FL-19 (CONTRACTS §2.2) — one `confirmation_required` answer for every caller: the class from
// the catalogue, the hint that says what to send; token-style fields are ignored.
@UseInterceptors(FleetConfirmationInterceptor)
export class FleetGitIdentityController {
    constructor(private readonly identity: FleetGitIdentityService) {}

    @Get('nodes/:id/git/identity')
    @ApiOperation({
        summary:
            "A computer's global git identity: name, email, whether a credential helper is set, and whether Ever Works can push for agents there. The values are shown to the computer's owner only. Needs `--manage` on the computer.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_GIT_IDENTITY_PER_MINUTE * 3, ttl: 60_000 } })
    async read(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetGitIdentityQueryDto,
    ): Promise<FleetGitIdentity> {
        return this.identity.read(
            id,
            { kind: 'user', userId: auth.userId },
            { fresh: query.fresh === '1' },
        );
    }

    @Post('nodes/:id/git/identity')
    @ApiOperation({
        summary:
            "Use my Ever Works identity: set the computer's global git user.name to my display name and user.email to my GitHub no-reply address (my account email when no GitHub account is linked). Only on my own computer; nothing else is written. Without `confirm: true` it answers `confirmation_required` with the sentence to show.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_GIT_IDENTITY_PER_MINUTE, ttl: 60_000 } })
    async set(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SetFleetGitIdentityDto,
    ): Promise<FleetGitIdentitySetResult> {
        return this.identity.set(
            id,
            { kind: 'user', userId: auth.userId },
            { confirm: body.confirm === true },
        );
    }
}
