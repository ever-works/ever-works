import { Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SkillsService } from '@ever-works/agent/skills';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 9. Standalone controller for
 * the `DELETE /skill-bindings/:id` endpoint per
 * `features/skills/plan.md §4`. Kept off the main `/skills/:id/...`
 * route so callers can drop a binding without needing the parent
 * skillId at hand (UI deletes the binding row given only its id).
 */
@ApiTags('skills')
@Controller('api/skill-bindings')
export class SkillBindingsController {
    constructor(private readonly service: SkillsService) {}

    @Delete(':id')
    @ApiOperation({ summary: 'Remove one Skill binding by id.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 60, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deleted: true }> {
        return this.service.removeBinding(auth.userId, id);
    }
}
