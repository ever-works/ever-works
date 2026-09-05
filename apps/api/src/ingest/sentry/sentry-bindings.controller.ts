import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { ClaimSentryBindingDto } from '../dto/sentry-binding.dto';
import { SentryInstallBindingService } from './sentry-install-binding.service';

/**
 * Sentry installation claims (self-build program note §6, R23) — the
 * authenticated half of the Sentry intake. The receiver
 * (`POST /api/ingest/sentry/events`) can verify that a delivery came
 * from Sentry but not WHOSE it is, so the owner claims the installation
 * uuid here first; deliveries for an unclaimed installation are a 200
 * no-op and file nothing.
 *
 * Auth: current user (platform session). Every row is owner-scoped —
 * listing shows only your claims and releasing somebody else's uuid is
 * a 404, never a hint that it exists.
 */
@ApiTags('ingest')
@Controller('api/ingest/sentry/bindings')
export class SentryBindingsController {
    constructor(private readonly bindings: SentryInstallBindingService) {}

    @Get()
    @ApiOperation({ summary: 'List the Sentry installations I have claimed.' })
    @HttpCode(HttpStatus.OK)
    async list(@CurrentUser() auth: AuthenticatedUser) {
        return { data: await this.bindings.listForUser(auth.userId) };
    }

    @Post()
    @ApiOperation({
        summary:
            'Claim a Sentry installation uuid — its verified deliveries become my incidents. First claim wins (409 otherwise).',
    })
    @HttpCode(HttpStatus.CREATED)
    async claim(@CurrentUser() auth: AuthenticatedUser, @Body() dto: ClaimSentryBindingDto) {
        return this.bindings.claim(auth.userId, dto.installationUuid, dto.label ?? null);
    }

    @Delete(':installationUuid')
    @ApiOperation({ summary: 'Release a Sentry installation I claimed.' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async unbind(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('installationUuid', new ParseUUIDPipe()) installationUuid: string,
    ): Promise<void> {
        const removed = await this.bindings.unbind(auth.userId, installationUuid);
        if (!removed) {
            throw new NotFoundException('Sentry installation binding not found');
        }
    }
}
