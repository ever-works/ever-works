import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthSessionGuard, CurrentUser } from '../../auth';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { ComposioService } from './composio.service';
import {
    ComposioConnectedAccountListDto,
    ComposioToolkitListDto,
    InitiateConnectionRequestDto,
    InitiateConnectionResponseDto,
} from './dto/composio.dto';

@ApiTags('Composio')
@ApiBearerAuth('JWT-auth')
@Controller('api/plugins/composio')
@UseGuards(AuthSessionGuard)
export class ComposioController {
    constructor(private readonly composio: ComposioService) {}

    @Get('toolkits')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List Composio toolkits',
        description: "Lists toolkits the caller's stored Composio API key has access to.",
    })
    @ApiResponse({ status: 200, type: ComposioToolkitListDto })
    async listToolkits(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
    ): Promise<ComposioToolkitListDto> {
        const parsed = limit !== undefined ? Number(limit) : 100;
        const items = await this.composio.listToolkits(
            auth.userId,
            Number.isFinite(parsed) ? parsed : 100,
        );
        return { items };
    }

    @Get('connected-accounts')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "List the caller's Composio connected accounts",
        description:
            "Returns the caller's connected accounts on Composio, optionally filtered by toolkit slug. Used by the settings UI to render connection status chips.",
    })
    @ApiResponse({ status: 200, type: ComposioConnectedAccountListDto })
    async listConnectedAccounts(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('toolkit') toolkit?: string,
    ): Promise<ComposioConnectedAccountListDto> {
        const items = await this.composio.listConnectedAccounts(auth.userId, {
            toolkitSlug: toolkit,
        });
        return { items };
    }

    @Post('connect')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Initiate a Composio OAuth connection',
        description:
            'Initiates a new connected account via `connectedAccounts.initiate`. Returns the OAuth redirect URL the frontend should open in a popup. The frontend polls `/connected-accounts` to detect the ACTIVE transition.',
    })
    @ApiResponse({ status: 200, type: InitiateConnectionResponseDto })
    async initiateConnection(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: InitiateConnectionRequestDto,
    ): Promise<InitiateConnectionResponseDto> {
        return this.composio.initiateConnection(auth.userId, body);
    }
}
