import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MissionsService, type MissionDto } from '@ever-works/agent/missions';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Phase 3 PR G — MissionsController skeleton (Missions/Ideas/Works
 * build).
 *
 * Ships only the `GET /me/missions` list endpoint so the module
 * boots cleanly and `/api/me/missions` round-trips (returning []
 * for users with no Missions yet). Phase 3 PR H adds the full
 * CRUD + lifecycle surface (create / get-one / update / pause /
 * resume / complete / delete / run-now); Phase 3 PR HH adds
 * `POST /:id/clone`.
 *
 * Decorated with `@ApiTags('missions')` + `@ApiOperation` per
 * Decision A19 so the Phase 9 PR Z2 MCP whitelist auto-derivation
 * can pick the endpoint up without extra config.
 */
@ApiTags('missions')
@Controller('api/me/missions')
export class MissionsController {
    constructor(private readonly service: MissionsService) {}

    @Get()
    @ApiOperation({ summary: 'List my missions' })
    @HttpCode(HttpStatus.OK)
    async list(@CurrentUser() auth: AuthenticatedUser): Promise<MissionDto[]> {
        return this.service.listForUser(auth.userId);
    }
}
