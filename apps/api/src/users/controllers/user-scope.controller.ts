import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ACTIVE_SCOPE_RESPONSE_SCHEMA, type ActiveScopeResponse } from '@ever-works/contracts/api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { UpdateActiveScopeDto } from '../dto/update-active-scope.dto';
import { ActiveScopeService } from '../services/active-scope.service';

@ApiTags('Users')
@ApiBearerAuth('JWT-auth')
@Controller('api/users/me/scope')
export class UserScopeController {
    constructor(private readonly activeScopeService: ActiveScopeService) {}

    @Get()
    @ApiOperation({ summary: 'Get the authenticated user active Organization scope' })
    @ApiResponse({ status: 200, schema: ACTIVE_SCOPE_RESPONSE_SCHEMA })
    get(@CurrentUser() auth: AuthenticatedUser): Promise<ActiveScopeResponse> {
        return this.activeScopeService.getActiveScope(auth.userId);
    }

    @Post()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Persist the authenticated user active Organization scope' })
    @ApiResponse({ status: 200, schema: ACTIVE_SCOPE_RESPONSE_SCHEMA })
    @ApiResponse({ status: 404, description: 'Organization not found for this user' })
    update(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: UpdateActiveScopeDto,
    ): Promise<ActiveScopeResponse> {
        return this.activeScopeService.updateActiveScope(auth.userId, body.organizationSlug);
    }
}
