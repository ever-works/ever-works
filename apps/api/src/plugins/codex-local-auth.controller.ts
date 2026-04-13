import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';

import { CodexLocalAuthService, type CodexLocalAuthStatus } from './codex-local-auth.service';

@ApiTags('Plugins')
@ApiBearerAuth('JWT-auth')
@Controller('api/plugins/codex')
@UseGuards(JwtAuthGuard)
export class CodexLocalAuthController {
    constructor(private readonly codexLocalAuthService: CodexLocalAuthService) {}

    @Get('local-auth-status')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get local auth status for Codex',
        description: 'Returns machine-local authentication status for the Codex CLI flow.',
    })
    @ApiResponse({ status: 200, description: 'Local auth status' })
    async getLocalAuthStatus(
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<CodexLocalAuthStatus> {
        return this.codexLocalAuthService.getStatus(auth.userId);
    }

    @Post('start-local-auth')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Start local auth for Codex',
        description: 'Starts a machine-local Codex CLI device-auth flow.',
    })
    @ApiResponse({ status: 200, description: 'Local auth session started' })
    async startLocalAuth(@CurrentUser() auth: AuthenticatedUser): Promise<CodexLocalAuthStatus> {
        return this.codexLocalAuthService.startDeviceAuth(auth.userId);
    }
}
