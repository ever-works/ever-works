import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { UsernameAllocatorService } from '../services/username-allocator.service';
import { CheckUsernameQueryDto } from '../dto/check-username.dto';

/**
 * EW-652 (Tenants & Organizations Phase 0) — public users API surface.
 *
 * The only endpoint today is `GET /api/users/check-username`. The
 * controller exists as its own surface (separate from `AuthController`)
 * because future endpoints — profile lookup by slug for the slug
 * routing layer (EW-659 Phase 7), public user info for the
 * WorkspaceSwitcher (EW-660 Phase 8) — will all live under
 * `/api/users/*` regardless of whether they involve auth.
 */
@ApiTags('Users')
@Controller('api/users')
export class UsersController {
    constructor(private readonly usernameAllocator: UsernameAllocatorService) {}

    /**
     * Check whether a username is available, with a normalized form +
     * collision-free suggestion.
     *
     * Used by interactive signup / settings rename forms to show
     * "username taken — suggested: ever-2" hints before submit.
     *
     * Public + throttled because it's reachable pre-login.
     */
    @Public()
    // Security: reduced from 30 to 5 req/min to slow unauthenticated slug enumeration while
    // still supporting interactive signup UX (a user rarely needs more than a few checks/min).
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @Get('check-username')
    @ApiOperation({
        summary: 'Check username availability',
        description:
            'Returns `{ available, normalized, suggestion? }`. The `normalized` field is what the platform would store; `suggestion` (only when not available) is the next free variant.',
    })
    @ApiQuery({
        name: 'value',
        description: 'Desired username (will be normalized)',
        required: true,
    })
    @ApiResponse({
        status: 200,
        description: 'Availability result',
        schema: {
            type: 'object',
            properties: {
                available: { type: 'boolean' },
                normalized: { type: 'string' },
                suggestion: { type: 'string', nullable: true },
            },
            required: ['available', 'normalized'],
        },
    })
    async checkUsername(@Query() query: CheckUsernameQueryDto): Promise<{
        available: boolean;
        normalized: string;
        suggestion?: string;
    }> {
        return this.usernameAllocator.suggest(query.value);
    }
}
