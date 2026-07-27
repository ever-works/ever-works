import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OnboardingRoleSeedingService } from '@ever-works/agent/agents';
import type {
    OnboardingSeedResponse,
    OnboardingSeedSuggestionsResponse,
} from '@ever-works/contracts/api';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { OnboardingStateService } from './onboarding-state.service';
import { ONBOARDING_MAX_SEED_ROLES, OnboardingSeedRequestDto } from './dto/onboarding-seed.dto';

/**
 * A55 — role-driven starter seeding, server-side.
 *
 * `GET  /api/onboarding/suggestions`      resolve the kit for some roles
 * `POST /api/onboarding/suggestions/seed` activate that kit for the caller
 *
 * Both are auth-required (the global session guard). The resolution
 * itself is catalog data, but the seed endpoint creates rows owned by
 * the caller, and keeping the pair on the same guard means the UI never
 * has to reason about "this half needs a session and that half does
 * not".
 *
 * Splitting resolve from seed is deliberate: the wizard shows the kit
 * first and only creates when the user asks. `GET` therefore has no
 * side effects at all, and `POST` is idempotent per template.
 */
@ApiTags('onboarding')
@Controller('api/onboarding/suggestions')
export class OnboardingSuggestionsController {
    constructor(
        private readonly seeding: OnboardingRoleSeedingService,
        private readonly stateService: OnboardingStateService,
    ) {}

    @Get()
    @ApiOperation({
        summary:
            'Resolve the starter kit (prebuilt agents + skills) for a set of onboarding roles. Every role in ROLE_OPTIONS is covered.',
    })
    @ApiQuery({
        name: 'roles',
        required: false,
        description:
            'Comma-separated role ids (repeatable). Omit to use the roles saved on the caller’s onboarding state.',
    })
    @HttpCode(HttpStatus.OK)
    async suggest(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('roles') roles?: string | string[],
    ): Promise<OnboardingSeedSuggestionsResponse> {
        const requested = parseRolesQuery(roles);
        const effective = requested.length > 0 ? requested : await this.savedRoles(auth.userId);
        return this.seeding.suggest(effective);
    }

    @Post('seed')
    @ApiOperation({
        summary:
            'Create the starter agents for the caller’s onboarding roles. Idempotent per template; partial failures are reported, never thrown.',
    })
    @HttpCode(HttpStatus.OK)
    // Seeding writes rows. The cap is generous enough for a user who
    // re-runs the step a few times and tight enough that it cannot be
    // used to bulk-create agents.
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async seed(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: OnboardingSeedRequestDto,
    ): Promise<OnboardingSeedResponse> {
        const requested = Array.isArray(body.roles)
            ? body.roles.slice(0, ONBOARDING_MAX_SEED_ROLES)
            : [];
        const effective = requested.length > 0 ? requested : await this.savedRoles(auth.userId);
        return this.seeding.seed(auth.userId, effective);
    }

    /**
     * Roles the user already answered with. Best-effort: a state read
     * failure degrades to "no roles" (an empty kit) rather than failing
     * a suggestion call — the wizard can always pass roles explicitly.
     */
    private async savedRoles(userId: string): Promise<string[]> {
        try {
            const state = await this.stateService.getState(userId);
            return [...(state.state.profile?.roles ?? [])];
        } catch {
            return [];
        }
    }
}

/**
 * Accept both `?roles=a,b` and `?roles=a&roles=b` — Nest hands the
 * second form over as an array, and a caller should not have to know
 * which one this endpoint prefers.
 */
export function parseRolesQuery(raw: string | string[] | undefined): string[] {
    const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const out: string[] = [];
    for (const part of parts) {
        for (const piece of part.split(',')) {
            const trimmed = piece.trim();
            if (trimmed && !out.includes(trimmed)) out.push(trimmed);
        }
    }
    return out.slice(0, ONBOARDING_MAX_SEED_ROLES);
}
