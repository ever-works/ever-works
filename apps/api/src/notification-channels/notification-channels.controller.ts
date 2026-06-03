import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Req,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { CurrentUser, AuthSessionGuard, Public } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { NotificationChannelsService } from './notification-channels.service';

// Security: the @Body() handlers previously typed the request against the
// `CreateChannelInput` / `UpdateChannelInput` TypeScript *interfaces*. Because
// class-transformer has no runtime metadata for a bare interface, the global
// ValidationPipe ({ whitelist, forbidNonWhitelisted }) was a no-op on these
// routes — extra attacker-controlled fields passed straight through to
// `channels.save(...)` and string fields had no length cap. The DTO classes
// below restore whitelist stripping + per-field bounds. They stay structurally
// assignable to the service-layer input interfaces.

// Security: hard cap on the serialized size of the free-form `targetConfig`
// blob (stored as a `simple-json` TEXT column). The global Express body limit
// bounds the whole request, but this keeps a single channel row's JSON payload
// from monopolizing that budget / the column.
const MAX_TARGET_CONFIG_BYTES = 16 * 1024;

function assertTargetConfigSize(targetConfig: Record<string, unknown> | undefined): void {
    if (targetConfig === undefined) return;
    let serialized: string;
    try {
        serialized = JSON.stringify(targetConfig);
    } catch {
        // Circular / non-serializable structures can never round-trip through
        // the simple-json column — reject rather than letting TypeORM throw deep
        // in the persistence layer.
        throw new BadRequestException('targetConfig must be a plain JSON object');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TARGET_CONFIG_BYTES) {
        throw new BadRequestException(
            `targetConfig exceeds the ${MAX_TARGET_CONFIG_BYTES}-byte limit`,
        );
    }
}

class CreateChannelDto {
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    pluginId: string;

    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name: string;

    @IsObject()
    targetConfig: Record<string, unknown>;
}

class UpdateChannelDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name?: string;

    @IsOptional()
    @IsObject()
    targetConfig?: Record<string, unknown>;

    @IsOptional()
    @IsBoolean()
    disabled?: boolean;
}

/**
 * EW-663 / EW-673 — Notification channel REST API.
 */
@ApiTags('Notification Channels')
@Controller('api/notification-channels')
export class NotificationChannelsController {
    constructor(private readonly service: NotificationChannelsService) {}

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Get()
    @ApiOperation({ summary: 'List my notification channels' })
    async list(@CurrentUser() auth: AuthenticatedUser) {
        const channels = await this.service.list(auth.userId);
        return { channels };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Post()
    @HttpCode(HttpStatus.CREATED)
    // Security: throttle channel creation. A per-user channel-count cap still
    // belongs in NotificationChannelsService.create() (separate file) — see the
    // deferred audit note — but this rate limit blunts the tight-loop storage
    // DoS in the meantime. Matches the 20/min create cap used elsewhere.
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    @ApiOperation({ summary: 'Add a notification channel' })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateChannelDto) {
        assertTargetConfigSize(body.targetConfig);
        const channel = await this.service.create(auth.userId, body);
        return { channel };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Patch(':id')
    @Throttle({ long: { ttl: 60_000, limit: 30 } })
    @ApiOperation({ summary: 'Update a notification channel' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        // Security: ParseUUIDPipe so a non-UUID `:id` is rejected with a clean
        // 400 instead of reaching TypeORM and surfacing a Postgres
        // invalid-uuid error. Matches MissionsController / WebhooksController.
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateChannelDto,
    ) {
        assertTargetConfigSize(body.targetConfig);
        const channel = await this.service.update(auth.userId, id, body);
        return { channel };
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Remove a notification channel' })
    // Security: ParseUUIDPipe — reject non-UUID ids with a clean 400.
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        await this.service.remove(auth.userId, id);
    }

    @UseGuards(AuthSessionGuard)
    @ApiBearerAuth('JWT-auth')
    @Post(':id/test')
    @ApiOperation({ summary: 'Send a test message via this channel' })
    // Security: ParseUUIDPipe — reject non-UUID ids with a clean 400.
    async sendTest(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.service.sendTest(auth.userId, id);
    }

    @Public()
    @Post('events/:pluginId')
    @Throttle({ long: { ttl: 60_000, limit: 600 } })
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({ summary: 'Provider delivery-event webhook for channels' })
    async eventsWebhook(
        @Param('pluginId') pluginId: string,
        @Req() _req: Request,
        @Headers() _headers: Record<string, string>,
    ) {
        // Security: this endpoint is @Public() and has NO signature
        // verification yet. Until per-plugin HMAC verification is wired through
        // the NotificationChannelFacadeService (the email-controller pattern:
        // facade.parseEventWebhook(pluginId, rawBody, headers) throws → 401),
        // this handler MUST NOT read or act on the request body / headers — it
        // only acks so the provider stops retrying. Do not add side effects
        // here before that verification lands (EW-673 P3).
        //
        // Security: constrain the reflected `pluginId` to a plugin-id shape so
        // an anonymous caller can't echo an arbitrarily large/garbage string
        // back through the response.
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(pluginId)) {
            throw new BadRequestException('Invalid pluginId');
        }
        return { received: true, pluginId };
    }
}
