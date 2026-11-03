import {
    Body,
    Controller,
    Get,
    Header,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Request,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import { SessionOnlyGuard } from '../../auth/guards/session-only.guard';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import {
    ProvisionCompanyDto,
    ProvisionIntakeDto,
    ProvisionTransactionDto,
} from './dto/provision.dto';
import {
    EverConnectProvisionService,
    type ProvisionCompanyResponse,
    type ProvisionIntakeResponse,
    type ProvisionSummaryResponse,
} from './ever-connect-provision.service';

/**
 * Creating a company a person asked for in Ever, under `/api/ever-connect/provision`.
 * The module is loaded only with `EVER_CONNECT_PROVISIONING_ENABLED=true`, so every
 * route answers 404 otherwise. No answer is cached, and none of these routes is
 * offered to agents.
 *
 * - `POST /provision {intent}` (public, 10 a minute per address): verifies the
 *   signed request and answers a sealed handle. Nothing else is created.
 * - `POST /provision/summary {provisionTxn}`: what the confirmation page shows.
 * - `POST /provision/company {provisionTxn, …}` with `Idempotency-Key`: the person
 *   confirmed.
 * - `POST /provision/intents/:jti/reject`: the person declined.
 * - `GET /provision/status/:jti`: status and slugs only.
 *
 * All but the first take the person's own session only, and the Ever ID connected
 * to it must be the one the request names.
 */
@ApiTags('Ever Connect')
@Controller('api/ever-connect/provision')
export class EverConnectProvisionController {
    constructor(private readonly provisions: EverConnectProvisionService) {}

    @Public()
    @Post()
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Receive a signed request from Ever Platform to create a company',
        description: 'Verifies the request and keeps it. Nothing else is created.',
    })
    @ApiResponse({ status: 200, description: 'A sealed handle and what the page shows' })
    @ApiResponse({ status: 401, description: '`intent_invalid`' })
    @ApiResponse({ status: 409, description: '`intent_consumed`, `not_connected`' })
    @ApiResponse({ status: 410, description: '`intent_expired`' })
    @ApiResponse({ status: 422, description: '`product_mismatch`' })
    @ApiResponse({ status: 503, description: '`connector_unavailable`' })
    async intake(@Body() body: ProvisionIntakeDto): Promise<ProvisionIntakeResponse> {
        return this.provisions.intake(body.intent);
    }

    @Post('summary')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'What the company confirmation page shows' })
    @ApiResponse({ status: 403, description: '`sessionRequired`, `intent_subject_mismatch`' })
    @ApiResponse({ status: 404, description: '`intent_not_found`' })
    @ApiResponse({ status: 410, description: '`intent_expired`' })
    async summary(
        @Request() req: { user: AuthenticatedUser },
        @Body() body: ProvisionTransactionDto,
    ): Promise<ProvisionSummaryResponse> {
        return this.provisions.summary(req.user.userId, body.provisionTxn);
    }

    @Post('company')
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 5, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiHeader({ name: 'Idempotency-Key', required: true, description: '1 to 128 characters' })
    @ApiOperation({
        summary: 'Create the company the person confirmed',
        description:
            'One repeat-safe call: the Company Work, the Organization and its link, then starter staff with agents paused and the first Mission. A failed staffing or Mission step leaves the company in place and answers `partial`. The same confirmation again answers the same ids with 200.',
    })
    @ApiResponse({ status: 200, description: 'The company made before, the same ids' })
    @ApiResponse({ status: 201, description: 'Created, or `partial`' })
    @ApiResponse({ status: 400, description: '`validation`' })
    @ApiResponse({ status: 403, description: '`sessionRequired`, `intent_subject_mismatch`' })
    @ApiResponse({ status: 404, description: '`intent_not_found`, `template_not_found`' })
    @ApiResponse({
        status: 409,
        description:
            '`intent_consumed`, `idempotency_key_reused_with_different_body`, `not_connected`, `tenant_already_linked`, `organization_already_linked`, `provisioning_in_progress`',
    })
    @ApiResponse({ status: 410, description: '`intent_expired`' })
    @ApiResponse({ status: 422, description: '`slug_invalid`' })
    async company(
        @Request() req: { user: AuthenticatedUser },
        @Headers('idempotency-key') idempotencyKey: string | undefined,
        @Body() body: ProvisionCompanyDto,
        @Res({ passthrough: true }) res: { status(code: number): unknown },
    ): Promise<ProvisionCompanyResponse> {
        const { created, answer } = await this.provisions.createCompany(
            req.user.userId,
            idempotencyKey,
            body,
        );
        res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
        return answer;
    }

    @Post('intents/:jti/reject')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'The person declined: nothing is created and Ever Platform is told',
    })
    @ApiResponse({ status: 403, description: '`sessionRequired`, `intent_subject_mismatch`' })
    @ApiResponse({ status: 404, description: '`intent_not_found`' })
    @ApiResponse({ status: 409, description: '`intent_consumed`' })
    async reject(@Request() req: { user: AuthenticatedUser }, @Param('jti') jti: string) {
        return this.provisions.reject(req.user.userId, jti);
    }

    @Get('status/:jti')
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'Where a request stands: status and slugs only' })
    @ApiResponse({ status: 403, description: '`sessionRequired`, `intent_subject_mismatch`' })
    @ApiResponse({ status: 404, description: '`intent_not_found`' })
    async status(@Request() req: { user: AuthenticatedUser }, @Param('jti') jti: string) {
        return this.provisions.status(req.user.userId, jti);
    }
}
