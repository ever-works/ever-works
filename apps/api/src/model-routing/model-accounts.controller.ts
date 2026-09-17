import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ModelAccountService } from '@ever-works/agent/model-routing';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    CreateModelAccountDto,
    ReorderModelAccountsDto,
    ReplaceModelAccountCredentialsDto,
    UpdateModelAccountDto,
} from './dto/model-accounts.dto';
import { ModelWorkspaceAccessService } from './model-workspace-access.service';

/**
 * Model accounts (AW-16) — a workspace's accounts per AI provider.
 *
 *   GET    /api/model-accounts                   accounts, by provider then position
 *   GET    /api/model-accounts/providers         installed AI providers + their credential fields
 *   POST   /api/model-accounts                   add an account (credential checked first)
 *   POST   /api/model-accounts/reorder           save a provider's new order
 *   PATCH  /api/model-accounts/:id               rename, pause or resume
 *   POST   /api/model-accounts/:id/credentials   replace the credential in place (reconnect)
 *   POST   /api/model-accounts/:id/check         check the credential now
 *   DELETE /api/model-accounts/:id               remove, closing the gap in the order
 *
 * The workspace is the session's active scope; members read, admins change.
 * No route returns a credential in any shape: every account leaves through
 * `toModelAccountView`, which has no credential field.
 *
 * Refusals: 409 `limit_reached` / `duplicate_label` / `stale_order`, 422
 * `credential_rejected` / `unknown_provider` / `no_credential_fields`, 400
 * `invalid_credentials` / `invalid_label`, 404 for an id in another workspace.
 */
@ApiTags('Model accounts')
@Controller('api/model-accounts')
@UseGuards(AuthSessionGuard)
@ApiBearerAuth('JWT-auth')
export class ModelAccountsController {
    constructor(
        private readonly accounts: ModelAccountService,
        private readonly access: ModelWorkspaceAccessService,
    ) {}

    @Get()
    @ApiOperation({ summary: "The workspace's provider accounts, grouped by provider in order" })
    @ApiResponse({ status: 200, description: 'Accounts. No credential of any kind is included.' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('providerPluginId') providerPluginId?: string,
    ) {
        const scope = await this.access.resolve(auth.userId, 'read');
        return { accounts: await this.accounts.list(scope, providerPluginId || undefined) };
    }

    @Get('providers')
    @ApiOperation({
        summary:
            "Installed AI providers an account can be held for, with the credential fields each one's own settings declare",
    })
    @ApiResponse({ status: 200, description: 'Providers.' })
    async providers(@CurrentUser() auth: AuthenticatedUser) {
        const scope = await this.access.resolve(auth.userId, 'read');
        return { providers: await this.accounts.listProviders(scope) };
    }

    @Post()
    @ApiOperation({
        summary:
            'Add an account. The credential is checked with the provider before anything is saved.',
    })
    @ApiResponse({ status: 201, description: 'The new account.' })
    @ApiResponse({ status: 409, description: 'limit_reached or duplicate_label.' })
    @ApiResponse({
        status: 422,
        description: 'credential_rejected, unknown_provider or no_credential_fields.',
    })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateModelAccountDto) {
        const scope = await this.access.resolve(auth.userId, 'write');
        return {
            account: await this.accounts.create(scope, {
                providerPluginId: body.providerPluginId,
                label: body.label,
                credentials: body.credentials,
                position: body.position,
            }),
        };
    }

    @Post('reorder')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "Save a provider's account order. The order is the order accounts are used in.",
    })
    @ApiResponse({ status: 200, description: 'The provider accounts in their new order.' })
    @ApiResponse({
        status: 409,
        description: 'stale_order — someone changed the order; nothing was written.',
    })
    async reorder(@CurrentUser() auth: AuthenticatedUser, @Body() body: ReorderModelAccountsDto) {
        const scope = await this.access.resolve(auth.userId, 'write');
        return {
            accounts: await this.accounts.reorder(scope, {
                providerPluginId: body.providerPluginId,
                orderedIds: body.orderedIds,
                expectedOrder: body.expectedOrder,
            }),
        };
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Rename, pause or resume an account. Its position is kept.' })
    @ApiResponse({ status: 200, description: 'The account.' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateModelAccountDto,
    ) {
        const scope = await this.access.resolve(auth.userId, 'write');
        return {
            account: await this.accounts.update(scope, id, {
                label: body.label,
                enabled: body.enabled,
            }),
        };
    }

    @Post(':id/credentials')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            "Replace an account's credential in place (reconnect), keeping its position, name and history",
    })
    @ApiResponse({ status: 200, description: 'The account.' })
    @ApiResponse({ status: 422, description: 'credential_rejected — the old credential is kept.' })
    async replaceCredentials(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: ReplaceModelAccountCredentialsDto,
    ) {
        const scope = await this.access.resolve(auth.userId, 'write');
        return { account: await this.accounts.replaceCredentials(scope, id, body.credentials) };
    }

    @Post(':id/check')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Check an account's credential now" })
    @ApiResponse({ status: 200, description: 'The account with its fresh health.' })
    async check(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        const scope = await this.access.resolve(auth.userId, 'write');
        return { account: await this.accounts.check(scope, id) };
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Remove an account and close the gap in its provider order' })
    @ApiResponse({
        status: 200,
        description: 'The remaining accounts of that provider, renumbered.',
    })
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        const scope = await this.access.resolve(auth.userId, 'write');
        const { removed, renumbered } = await this.accounts.remove(scope, id);
        return { ok: true, removed, renumbered };
    }
}
