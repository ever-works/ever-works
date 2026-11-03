import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsPlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { SessionOnlyGuard } from '../auth/guards/session-only.guard';
import { EverConnectAcceptDto, EverConnectConnectDto } from './dto/ever-connect.dto';
import {
    EverConnectIntegrationService,
    type EverConnectIntegrationView,
} from './ever-connect-integration.service';
import {
    EverConnectOutboxService,
    type EverConnectOutboxStatus,
} from './ever-connect-outbox.service';
import { EverConnectService, type EverConnectStatus } from './ever-connect.service';
import { EverIdLoginHandler, type EverIdLoginClientStatus } from './identity/ever-id-login.handler';

/** The installation-wide integrations an administrator accepts here. */
const INSTANCE_WIDE_KEYS = new Set(['ever_id_login', 'instance_url', 'stats_link', 'webhooks']);

/** `GET /api/ever-connect/status`. */
export interface EverConnectAdminStatus {
    readonly connection: EverConnectStatus;
    readonly integrations: EverConnectIntegrationView[];
    readonly everIdClient: EverIdLoginClientStatus;
    readonly outbox: EverConnectOutboxStatus;
}

/**
 * Ever Platform connection — the operator routes (platform administrators only):
 *
 *   GET  /api/ever-connect/status                     the connection, integrations, Ever ID client, outbox
 *   POST /api/ever-connect/connect                    connect with an `EVC-…` code
 *   POST /api/ever-connect/disconnect                 disconnect (Ever Platform told, best effort)
 *   POST /api/ever-connect/integrations/refresh       read the integration states again
 *   POST /api/ever-connect/integrations/:key/accept   accept or decline an installation-wide integration
 *
 * The routes that change the connection also need the administrator's
 * interactive session (`SessionOnlyGuard`): an API key acting as the
 * administrator is refused. The module is not loaded unless
 * `EVER_CONNECT_ENABLED=true`, so every route then answers 404. Responses are
 * never cached and never carry a key, a token or a secret.
 */
@ApiTags('ever-connect')
@ApiBearerAuth('JWT-auth')
@Controller('api/ever-connect')
@UseGuards(IsPlatformAdminGuard)
export class EverConnectAdminController {
    constructor(
        private readonly connection: EverConnectService,
        private readonly integrations: EverConnectIntegrationService,
        private readonly login: EverIdLoginHandler,
        private readonly outbox: EverConnectOutboxService,
    ) {}

    @Get('status')
    @Header('Cache-Control', 'no-store')
    @ApiOperation({ summary: 'The connection to Ever Platform and what runs over it' })
    async status(): Promise<EverConnectAdminStatus> {
        return {
            connection: await this.connection.status(),
            integrations: await this.integrations.list(),
            everIdClient: this.login.getStatus(),
            outbox: await this.outbox.status(),
        };
    }

    @Post('connect')
    @HttpCode(HttpStatus.CREATED)
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
    @ApiOperation({ summary: 'Connect this installation with a connect code from app.ever.co' })
    @ApiResponse({ status: 400, description: '`code_invalid`: not a connect code' })
    @ApiResponse({ status: 409, description: '`already_connected`' })
    @ApiResponse({
        status: 422,
        description: 'Ever Platform refused the code (`code_invalid`, `code_expired`, …)',
    })
    async connect(@Body() body: EverConnectConnectDto): Promise<EverConnectStatus> {
        const status = await this.connection.connect(body.code);
        await this.integrations.refresh().catch(() => undefined);
        return status;
    }

    @Post('disconnect')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({ summary: 'Disconnect this installation from Ever Platform' })
    async disconnect(): Promise<EverConnectStatus> {
        return this.connection.disconnect();
    }

    @Post('integrations/refresh')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({ summary: 'Read the integration states from Ever Platform again' })
    async refresh(): Promise<EverConnectIntegrationView[]> {
        return this.integrations.refresh();
    }

    @Post('integrations/:key/accept')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionOnlyGuard)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary:
            'Accept or decline an installation-wide integration enabled in app.ever.co (it waits for this answer)',
    })
    @ApiResponse({ status: 404, description: '`not_pending`: nothing waits for an answer' })
    async accept(
        @Param('key') key: string,
        @Body() body: EverConnectAcceptDto,
    ): Promise<EverConnectIntegrationView[]> {
        if (!INSTANCE_WIDE_KEYS.has(key)) {
            throw new NotFoundException({
                code: 'not_pending',
                message: 'No integration waits for an answer here.',
            });
        }
        return this.integrations.accept(key, body.accepted);
    }
}
