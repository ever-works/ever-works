import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import { InboundTriggersService } from '@ever-works/agent/triggers';
import type {
    FireInboundTriggerResult,
    InboundTriggerScope,
    InboundTriggerView,
} from '@ever-works/agent/triggers';
import { CreateInboundTriggerDto, UpdateInboundTriggerDto } from './dto/inbound-trigger.dto';

/**
 * Inbound Triggers ("Trigger Schedules") — signed webhook/API triggers.
 *
 * Management surface (`/api/inbound-triggers`) is auth-guarded by the
 * global `AuthSessionGuard` and caller-scoped (userId + active
 * Organization via the request-scoped `ScopeContextService`); cross-org
 * access surfaces as 404 — never 403 — inside the service.
 *
 * The fire endpoint (`POST /api/inbound-triggers/:id/fire`) is
 * deliberately `@Public()` — external systems authenticate with the
 * per-trigger HMAC secret, not a session. The handler reads the RAW
 * request body (captured by main.ts's body-parser `verify` hook) so the
 * signature is computed over the exact bytes the sender signed:
 * hex HMAC-SHA256 over `${x-everworks-timestamp}.${rawBody}`.
 *
 * Security gates on fire:
 *  - timestamp within the 5-minute replay window
 *  - timing-safe HMAC check against the current secret, or (within the
 *    24h rotation grace) the previous one
 *  - constant-shape 401 on any verification failure (no detail leak)
 *  - tighter-than-global throttle (still per-IP via
 *    UserAwareThrottlerGuard for anonymous callers)
 */
@ApiTags('Inbound Triggers')
@Controller('api/inbound-triggers')
export class InboundTriggersController {
    constructor(
        private readonly triggers: InboundTriggersService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    private scope(auth: AuthenticatedUser): InboundTriggerScope {
        return {
            userId: auth.userId,
            organizationId: this.scopeContext.getOrganizationId(),
        };
    }

    @Get()
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: "List the caller's inbound triggers",
        description:
            'Returns every inbound trigger the caller owns in the active Organization scope (personal scope lists org-less triggers). Secret material is never included.',
    })
    @ApiResponse({ status: 200, description: 'Array of trigger views (no secret material)' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<{ triggers: InboundTriggerView[] }> {
        const triggers = await this.triggers.list(this.scope(auth));
        return { triggers };
    }

    @Post()
    @ApiBearerAuth('JWT-auth')
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Create an inbound trigger',
        description:
            'Creates a named trigger and returns the trigger view plus the RAW HMAC signing secret. The secret is returned ONLY in this response (and on rotate) — store it immediately. External systems then POST signed payloads to /api/inbound-triggers/{id}/fire.',
    })
    @ApiResponse({ status: 201, description: 'Trigger created; secret returned once' })
    @ApiResponse({ status: 400, description: 'Validation failed (bad name / foreign agent)' })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: CreateInboundTriggerDto,
    ): Promise<{ trigger: InboundTriggerView; secret: string }> {
        return this.triggers.create(this.scope(auth), dto);
    }

    @Get(':id')
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'Get one inbound trigger' })
    @ApiParam({ name: 'id', description: 'Trigger ID' })
    @ApiResponse({ status: 200, description: 'Trigger view (no secret material)' })
    @ApiResponse({ status: 404, description: 'Not found (or not yours)' })
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<InboundTriggerView> {
        return this.triggers.getOne(this.scope(auth), id);
    }

    @Patch(':id')
    @ApiBearerAuth('JWT-auth')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Update an inbound trigger (name, description, agent, title template)',
    })
    @ApiParam({ name: 'id', description: 'Trigger ID' })
    @ApiResponse({ status: 200, description: 'Updated trigger view' })
    @ApiResponse({ status: 404, description: 'Not found (or not yours)' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpdateInboundTriggerDto,
    ): Promise<InboundTriggerView> {
        return this.triggers.update(this.scope(auth), id, dto);
    }

    @Post(':id/rotate-secret')
    @ApiBearerAuth('JWT-auth')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Rotate the signing secret',
        description:
            'Generates a new HMAC signing secret and returns it ONCE. The previous secret keeps verifying for a 24-hour grace window, then stops.',
    })
    @ApiParam({ name: 'id', description: 'Trigger ID' })
    @ApiResponse({ status: 200, description: 'New secret returned once' })
    @ApiResponse({ status: 404, description: 'Not found (or not yours)' })
    async rotateSecret(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ trigger: InboundTriggerView; secret: string }> {
        return this.triggers.rotateSecret(this.scope(auth), id);
    }

    @Post(':id/pause')
    @ApiBearerAuth('JWT-auth')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Pause an inbound trigger',
        description: 'Paused triggers reject fire calls with 409 until resumed.',
    })
    @ApiParam({ name: 'id', description: 'Trigger ID' })
    @ApiResponse({ status: 200, description: 'Updated trigger view' })
    @ApiResponse({ status: 404, description: 'Not found (or not yours)' })
    async pause(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<InboundTriggerView> {
        return this.triggers.pause(this.scope(auth), id);
    }

    @Post(':id/resume')
    @ApiBearerAuth('JWT-auth')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({ summary: 'Resume a paused inbound trigger' })
    @ApiParam({ name: 'id', description: 'Trigger ID' })
    @ApiResponse({ status: 200, description: 'Updated trigger view' })
    @ApiResponse({ status: 404, description: 'Not found (or not yours)' })
    async resume(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<InboundTriggerView> {
        return this.triggers.resume(this.scope(auth), id);
    }

    @Delete(':id')
    @ApiBearerAuth('JWT-auth')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({ summary: 'Delete an inbound trigger (irreversible)' })
    @ApiParam({ name: 'id', description: 'Trigger ID' })
    @ApiResponse({ status: 204, description: 'Deleted' })
    @ApiResponse({ status: 404, description: 'Not found (or not yours)' })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        await this.triggers.remove(this.scope(auth), id);
    }

    @Public()
    @Post(':id/fire')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Fire an inbound trigger (public, HMAC-signed)',
        description:
            "External delivery endpoint — no session auth. Send the JSON payload with headers 'x-everworks-timestamp' (unix epoch seconds) and 'x-everworks-signature' (hex HMAC-SHA256 over `${timestamp}.${rawBody}` keyed with the trigger secret; optional 'sha256=' prefix). A verified call spawns a Task from the trigger's title template, assigned to its target Agent when set. 401 on any signature/timestamp failure, 404 for unknown ids, 409 while paused, 400 for oversized (>64 KB) or non-JSON payloads.",
    })
    @ApiParam({ name: 'id', description: 'Trigger ID (from the webhook URL)' })
    @ApiResponse({ status: 200, description: 'Payload accepted; Task spawned' })
    @ApiResponse({ status: 401, description: 'Invalid signature or timestamp' })
    @ApiResponse({ status: 404, description: 'Unknown trigger' })
    @ApiResponse({ status: 409, description: 'Trigger is paused' })
    async fire(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: { rawBody?: string },
        @Headers('x-everworks-signature') signature: string | undefined,
        @Headers('x-everworks-timestamp') timestamp: string | undefined,
        @Headers('content-type') contentType: string | undefined,
    ): Promise<FireInboundTriggerResult> {
        return this.triggers.fire(id, {
            rawBody: req.rawBody ?? '',
            signatureHeader: signature,
            timestampHeader: timestamp,
            contentType,
        });
    }
}
