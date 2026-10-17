import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { IntegrationForbiddenGuard } from '../../auth/integration/integration-forbidden.guard';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthSessionGuard } from '../../auth';
import { AuthenticatedUser } from '../../auth/types/auth.types';
import { DeviceAuthService } from './device-auth.service';

@ApiTags('Plugin Device Auth')
@ApiBearerAuth('JWT-auth')
@Controller('api/device-auth')
@UseGuards(AuthSessionGuard)
// EW-P1-2 — integration keys (`ew_int_…`) can never call these routes.
@UseGuards(IntegrationForbiddenGuard)
export class DeviceAuthController {
    constructor(private readonly deviceAuthService: DeviceAuthService) {}

    @Get(':pluginId/status')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get plugin device auth status',
        description:
            'Returns user-scoped device authentication status for plugins that support a managed device-code flow.',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, description: 'Device auth status' })
    async getStatus(@CurrentUser() auth: AuthenticatedUser, @Param('pluginId') pluginId: string) {
        return this.deviceAuthService.getStatus(auth.userId, pluginId);
    }

    @Post(':pluginId/start')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Start plugin device auth',
        description:
            'Starts a user-scoped device authentication flow for plugins that support managed device-code auth.',
    })
    @ApiParam({ name: 'pluginId', description: 'Plugin ID' })
    @ApiResponse({ status: 200, description: 'Device auth session started' })
    async start(@CurrentUser() auth: AuthenticatedUser, @Param('pluginId') pluginId: string) {
        return this.deviceAuthService.start(auth.userId, pluginId);
    }
}
