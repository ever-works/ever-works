import {
    Body,
    CanActivate,
    Controller,
    Delete,
    ExecutionContext,
    Get,
    HttpCode,
    HttpException,
    HttpStatus,
    Injectable,
    NotFoundException,
    Param,
    Patch,
    Post,
    Request,
    Res,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiConsumes,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { IdentityProviderCheck } from '@ever-works/plugin';
import {
    IDENTITY_PROVIDER_REQUIRED_CHECKS,
    IdentityProviderFacadeService,
    IdentityProviderUnavailableError,
} from '@ever-works/agent/facades';
import { UserRepository } from '@ever-works/agent/database';
import { Public } from '../decorators/public.decorator';
import {
    EverIdAdminSettingsDto,
    EverIdAuthorizationStartDto,
    EverIdAuthorizeDto,
    EverIdCallbackDto,
    EverIdClientConfigResponseDto,
    EverIdConnectConfirmDto,
    EverIdHealthResponseDto,
    EverIdLogoutUrlResponseDto,
    EverIdSignUpConfirmDto,
    ExternalIdentityListResponseDto,
    ExternalIdentityResponseDto,
} from '../dto/ever-id.dto';
import { EverIdEnabledGuard } from '../guards/ever-id-enabled.guard';
import { NoTokenInQueryGuard } from '../guards/no-token-in-query.guard';
import { SessionOnlyGuard } from '../guards/session-only.guard';
import { toHeaders } from '../providers/request-headers';
import type { AuthenticatedUser } from '../types/auth.types';
import {
    EverIdActivityService,
    type EverIdRequestContext,
} from '../services/ever-id-activity.service';
import { EverIdBackchannelService } from '../services/ever-id-backchannel.service';
import { everIdError } from '../services/ever-id-errors';
import { EverIdLinkingService } from '../services/ever-id-linking.service';
import { EverIdSessionService } from '../services/ever-id-session.service';
import { EverIdSignInService } from '../services/ever-id-sign-in.service';

/**
 * Platform administrators only — and a non-administrator is told the route does
 * not exist (`404`), not that it is forbidden, so the administrator surface is
 * not advertised (`apw-12.openapi.yaml`: "a non-admin answers 404").
 */
@Injectable()
export class EverIdAdminGuard implements CanActivate {
    constructor(private readonly users: UserRepository) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
        const userId = request.user?.userId;
        const user = userId ? await this.users.findById(userId) : null;
        if (!user?.isPlatformAdmin || request.user?.authMethod !== 'session') {
            throw new NotFoundException({
                status: 'error',
                code: 'not_found',
                message: 'Not Found',
            });
        }
        return true;
    }
}

/** What the administrator surface shows: state and provenance, never a secret value. */
export interface EverIdAdminStatus {
    enabled: boolean;
    configured: boolean;
    missing: string[];
    issuer: string | null;
    clientIdSet: boolean;
    clientSecretSet: boolean;
    displayName: string;
    signUpAllowed: boolean;
    localClients: number;
    unavailableSince: string | null;
    settingSources: Record<string, string>;
    /**
     * The administrator-managed values (`PATCH /admin/settings`), so the
     * administration page can show and edit them. None of them is a secret.
     */
    settings: {
        displayName: string;
        accountManagementUrl: string | null;
        localClients: Array<{ kind: 'cli' | 'node'; clientId: string }>;
        delegatedClientNames: Array<{ clientId: string; displayName: string }>;
    };
}

function requestContext(req: {
    ip?: unknown;
    headers?: Record<string, unknown>;
}): EverIdRequestContext {
    const forwarded = req.headers?.['x-forwarded-for'];
    const ipAddress =
        (typeof req.ip === 'string' && req.ip) ||
        (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
        null;
    const userAgent = req.headers?.['user-agent'];
    return { ipAddress, userAgent: typeof userAgent === 'string' ? userAgent : null };
}

function bearerOf(req: { headers?: Record<string, unknown> }): string | null {
    const authorization = req.headers?.authorization;
    if (typeof authorization !== 'string') return null;
    const [scheme, token] = authorization.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    return token.trim() || null;
}

/**
 * APW-12 (Ever ID) — the relying-party routes (plan §5.1,
 * `docs/specs/features/app-works/contracts/openapi/apw-12.openapi.yaml`).
 *
 * The sign-in family (authorize, callback, sign-up confirm, connect, terminal
 * exchange and client configuration, the provider sign-out address) answers
 * `404 everIdDisabled` unless a platform administrator turned Ever ID on — and
 * then makes no request to any identity provider (FR-5). {@link EverIdEnabledGuard}
 * answers it before the body is validated, so a malformed request gets the same
 * `404` as a well-formed one. Listing and
 * disconnecting connected identities and honouring sign-out notices keep
 * working while it is off (ACC-12-04).
 *
 * A token in the query string is refused with `400 tokenInQuery` on every route
 * (FR-17): by the global session guard first, by {@link NoTokenInQueryGuard} as
 * the controller-level belt. Error bodies follow the platform's
 * `{ status: 'error', code, message }` shape with snake_case codes. No route of
 * this controller is exposed to the agent tool surface.
 */
@ApiTags('Auth — Ever ID')
@Controller('api/auth/ever-id')
@UseGuards(NoTokenInQueryGuard)
export class EverIdController {
    constructor(
        private readonly signIn: EverIdSignInService,
        private readonly linking: EverIdLinkingService,
        private readonly sessions: EverIdSessionService,
        private readonly backchannel: EverIdBackchannelService,
        private readonly facade: IdentityProviderFacadeService,
        private readonly activity: EverIdActivityService,
    ) {}

    // ------------------------------------------------------------------
    // Browser sign-in
    // ------------------------------------------------------------------

    @Public()
    @Post('authorize')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdEnabledGuard)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    @ApiOperation({ summary: 'Start an Ever ID sign-in (authorization code + PKCE S256)' })
    @ApiBody({ type: EverIdAuthorizeDto, required: false })
    @ApiResponse({ status: 200, type: EverIdAuthorizationStartDto })
    @ApiResponse({ status: 400, description: '`token_in_query`' })
    @ApiResponse({ status: 404, description: '`ever_id_disabled` — Ever ID is not turned on' })
    @ApiResponse({ status: 503, description: '`provider_unavailable`' })
    async authorize(@Body() body: EverIdAuthorizeDto): Promise<EverIdAuthorizationStartDto> {
        return this.signIn.startSignIn(body?.returnTo);
    }

    @Public()
    @Post('callback')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdEnabledGuard)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Complete an Ever ID sign-in or connection',
        description:
            'Answers `signedIn`, `confirmSignUp`, `confirmConnect` or `emailInUse`. A bearer session is read only when the transaction was started from Settings (connect).',
    })
    @ApiResponse({ status: 200, description: 'An `EverIdCallbackOutcome`.' })
    @ApiResponse({ status: 400, description: '`transaction_invalid`, `token_in_query`' })
    @ApiResponse({ status: 401, description: '`transaction_invalid` — the ID token was refused' })
    @ApiResponse({
        status: 403,
        description:
            '`reauth_required`, `session_required`, `sign_up_not_allowed`, `account_disabled`',
    })
    @ApiResponse({ status: 404, description: '`ever_id_disabled`' })
    @ApiResponse({ status: 409, description: '`subject_linked`, `user_has_issuer`' })
    @ApiResponse({ status: 422, description: '`email_not_verified`' })
    @ApiResponse({ status: 503, description: '`provider_unavailable`' })
    async callback(@Body() body: EverIdCallbackDto, @Request() req) {
        return this.signIn.completeCallback(
            body,
            toHeaders(req.headers || {}),
            requestContext(req),
        );
    }

    @Public()
    @Post('sign-up/confirm')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdEnabledGuard)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Create the account after the confirmation screen (terms accepted)',
    })
    @ApiResponse({ status: 200, description: 'The token response, plus `returnTo`.' })
    @ApiResponse({ status: 400, description: '`transaction_invalid`, `terms_required`' })
    @ApiResponse({ status: 403, description: '`sign_up_not_allowed`' })
    @ApiResponse({ status: 404, description: '`ever_id_disabled`' })
    @ApiResponse({ status: 409, description: '`subject_linked`, `email_in_use`' })
    @ApiResponse({ status: 422, description: '`email_not_verified`' })
    async confirmSignUp(@Body() body: EverIdSignUpConfirmDto, @Request() req) {
        return this.linking.confirmSignUp(body.pending, body.terms, requestContext(req));
    }

    // ------------------------------------------------------------------
    // Connect from Settings (session only)
    // ------------------------------------------------------------------

    @Post('connect/authorize')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdEnabledGuard, SessionOnlyGuard)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'Start connecting Ever ID to the signed-in account (fresh sign-in)' })
    @ApiResponse({ status: 200, type: EverIdAuthorizationStartDto })
    @ApiResponse({ status: 403, description: '`reauth_required`, `session_required`' })
    @ApiResponse({ status: 404, description: '`ever_id_disabled`' })
    @ApiResponse({ status: 409, description: '`user_has_issuer`' })
    async connectAuthorize(@Request() req): Promise<EverIdAuthorizationStartDto> {
        const session = await this.sessions.currentSession(toHeaders(req.headers || {}));
        return this.signIn.startConnect(req.user as AuthenticatedUser, session);
    }

    @Post('connect/confirm')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdEnabledGuard, SessionOnlyGuard)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Connect the Ever ID the person just signed in with (S4 confirmation)',
    })
    @ApiResponse({ status: 200, type: ExternalIdentityResponseDto })
    @ApiResponse({ status: 400, description: '`transaction_invalid`' })
    @ApiResponse({ status: 403, description: '`session_required`' })
    @ApiResponse({ status: 404, description: '`ever_id_disabled`' })
    @ApiResponse({ status: 409, description: '`subject_linked`, `user_has_issuer`' })
    async connectConfirm(@Body() body: EverIdConnectConfirmDto, @Request() req) {
        return this.linking.confirmConnect(
            body.pending,
            (req.user as AuthenticatedUser).userId,
            requestContext(req),
        );
    }

    @Get('identities')
    @UseGuards(SessionOnlyGuard)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: "The signed-in account's connected identities (works while Ever ID is turned off)",
    })
    @ApiResponse({ status: 200, type: ExternalIdentityListResponseDto })
    @ApiResponse({ status: 403, description: '`session_required`' })
    async identities(@Request() req) {
        return this.linking.listIdentities((req.user as AuthenticatedUser).userId);
    }

    @Delete('identities/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    @UseGuards(SessionOnlyGuard)
    @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiParam({ name: 'id', description: 'The connected identity id.' })
    @ApiOperation({
        summary: 'Disconnect an identity (works while Ever ID is turned off)',
        description:
            'Refused with `409 last_sign_in_method` when it would leave no way to sign in. Ends every other session the identity opened; the current one continues.',
    })
    @ApiResponse({ status: 204, description: 'Disconnected.' })
    @ApiResponse({ status: 403, description: '`session_required`' })
    @ApiResponse({ status: 404, description: 'No such identity on this account.' })
    @ApiResponse({ status: 409, description: '`last_sign_in_method`' })
    async disconnect(@Param('id') id: string, @Request() req): Promise<void> {
        const session = await this.sessions.currentSession(toHeaders(req.headers || {}));
        await this.linking.disconnect(
            (req.user as AuthenticatedUser).userId,
            id,
            session?.id ?? null,
            requestContext(req),
        );
    }

    // ------------------------------------------------------------------
    // Sign-out
    // ------------------------------------------------------------------

    @Get('logout-url')
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: "The provider's sign-out address for the current session",
        description:
            'Only when the current session was opened with Ever ID and Ever ID is on; otherwise 404.',
    })
    @ApiResponse({ status: 200, type: EverIdLogoutUrlResponseDto })
    @ApiResponse({ status: 404, description: 'Not an Ever ID session, or Ever ID is off.' })
    async logoutUrl(@Request() req): Promise<EverIdLogoutUrlResponseDto> {
        if ((req.user as AuthenticatedUser | undefined)?.authMethod !== 'session') {
            throw new NotFoundException({
                status: 'error',
                code: 'not_found',
                message: 'Not Found',
            });
        }
        const session = await this.sessions.currentSession(toHeaders(req.headers || {}));
        return this.signIn.logoutUrl(session);
    }

    @Public()
    @Post('backchannel-logout')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiConsumes('application/x-www-form-urlencoded')
    @ApiOperation({
        summary: 'OpenID Connect back-channel logout (called by the identity provider)',
        description:
            'Ends the sessions Ever ID opened for the `sid` (or `sub`) the logout token names. Answers `Cache-Control: no-store`; an invalid notice is 400 with no detail; a notice for an unknown session is 200.',
    })
    @ApiBody({
        schema: {
            type: 'object',
            required: ['logout_token'],
            properties: { logout_token: { type: 'string' } },
        },
    })
    @ApiResponse({ status: 200, description: 'Accepted.' })
    @ApiResponse({ status: 400, description: 'Invalid logout token.' })
    async backchannelLogout(
        @Body('logout_token') logoutToken: unknown,
        @Request() req,
        @Res({ passthrough: true }) res,
    ): Promise<void> {
        if (res && typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
        await this.backchannel.handle(logoutToken, requestContext(req));
    }

    // ------------------------------------------------------------------
    // Terminal clients (device authorization, FR-39..FR-43)
    // ------------------------------------------------------------------

    @Public()
    @Post('session')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdEnabledGuard)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Exchange an Ever ID access token (device sign-in) for a session',
        description:
            'For terminal clients only. The token travels in the Authorization header; the session comes back in the body. Never creates an account.',
    })
    @ApiResponse({ status: 200, description: 'The token response.' })
    @ApiResponse({ status: 401, description: '`transaction_invalid` — the token was refused' })
    @ApiResponse({ status: 403, description: '`not_connected`, `account_disabled`' })
    @ApiResponse({ status: 404, description: '`ever_id_disabled`' })
    @ApiResponse({ status: 503, description: '`provider_unavailable`' })
    async session(@Request() req) {
        return this.signIn.exchangeDeviceToken(bearerOf(req), requestContext(req));
    }

    @Public()
    @Get('client-config')
    @UseGuards(EverIdEnabledGuard)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'What a terminal client needs to start a device sign-in (no secrets)',
    })
    @ApiResponse({ status: 200, type: EverIdClientConfigResponseDto })
    @ApiResponse({ status: 404, description: '`ever_id_disabled`' })
    async clientConfig(): Promise<EverIdClientConfigResponseDto> {
        return this.signIn.clientConfig();
    }

    // ------------------------------------------------------------------
    // Administration (platform admins; everyone else gets 404)
    // ------------------------------------------------------------------

    @Post('admin/test')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdAdminGuard)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Test connection: one row per check, within 5 seconds, never the secret',
        description:
            'Works while Ever ID is turned off, so a configuration can be checked before it is switched on.',
    })
    @ApiResponse({ status: 200, description: 'One `IdentityProviderCheck` per check id.' })
    @ApiResponse({ status: 404, description: 'Not a platform admin, or no identity provider.' })
    async adminTest(): Promise<IdentityProviderCheck[]> {
        return this.withProvider(() => this.facade.testConnection());
    }

    @Get('admin/health')
    @UseGuards(EverIdAdminGuard)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'Last discovery refresh, key refresh and sign-out notice' })
    @ApiResponse({ status: 200, type: EverIdHealthResponseDto })
    @ApiResponse({ status: 404, description: 'Not a platform admin.' })
    async adminHealth(): Promise<EverIdHealthResponseDto> {
        return this.facade.getHealth();
    }

    @Get('admin/status')
    @UseGuards(EverIdAdminGuard)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Whether Ever ID is turned on and configured, and where each setting comes from',
    })
    @ApiResponse({ status: 200, description: 'The status (never a secret value).' })
    @ApiResponse({ status: 404, description: 'Not a platform admin, or no identity provider.' })
    async adminStatus(): Promise<EverIdAdminStatus> {
        return this.status();
    }

    @Post('admin/enable')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdAdminGuard)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Turn sign-in with Ever ID on (runs Test connection first)',
        description:
            'Refused with `409 connection_test_failed` (and the checks) unless every required check passes. Records an Activity row.',
    })
    @ApiResponse({ status: 200, description: 'The new status.' })
    @ApiResponse({ status: 404, description: 'Not a platform admin, or no identity provider.' })
    @ApiResponse({ status: 409, description: '`connection_test_failed`' })
    async adminEnable(@Request() req): Promise<EverIdAdminStatus> {
        const configuration = await this.withProvider(() => this.facade.getConfigurationStatus());
        if (!configuration.configured) {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'not_configured',
                    message: 'Configure the issuer, client id and client secret first.',
                    missing: configuration.missing,
                },
                HttpStatus.CONFLICT,
            );
        }
        const checks = await this.withProvider(() => this.facade.testConnection());
        const failed = IDENTITY_PROVIDER_REQUIRED_CHECKS.filter(
            (id) => checks.find((check) => check.id === id)?.ok !== true,
        );
        if (failed.length > 0) {
            throw new HttpException(
                {
                    status: 'error',
                    code: 'connection_test_failed',
                    message: 'Test connection did not pass; Ever ID stays off.',
                    checks,
                },
                HttpStatus.CONFLICT,
            );
        }
        await this.facade.setEnabled(true);
        this.activity.configChanged(
            (req.user as AuthenticatedUser).userId,
            ['enabled'],
            requestContext(req),
        );
        return this.status();
    }

    @Patch('admin/settings')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdAdminGuard)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary:
            'Change the administrator-managed settings (local clients, app names, account link, display name)',
        description:
            'The issuer, the client and its secret are operator configuration and cannot be written here. Records an Activity row naming the fields (never their values).',
    })
    @ApiResponse({ status: 200, description: 'The new status.' })
    @ApiResponse({ status: 400, description: 'Invalid settings.' })
    @ApiResponse({ status: 404, description: 'Not a platform admin, or no identity provider.' })
    async adminSettings(
        @Body() body: EverIdAdminSettingsDto,
        @Request() req,
    ): Promise<EverIdAdminStatus> {
        const patch = Object.fromEntries(
            Object.entries({
                localClients: body.localClients?.map(({ kind, clientId }) => ({ kind, clientId })),
                delegatedClientNames: body.delegatedClientNames?.map(
                    ({ clientId, displayName }) => ({
                        clientId,
                        displayName,
                    }),
                ),
                accountManagementUrl: body.accountManagementUrl,
                displayName: body.displayName,
            }).filter(([, value]) => value !== undefined),
        );
        let fields: string[];
        try {
            fields = await this.withProvider(() => this.facade.updateSettings(patch));
        } catch (error) {
            if (error instanceof HttpException) throw error;
            throw new HttpException(
                {
                    status: 'error',
                    code: 'invalid_settings',
                    message: 'The settings were refused.',
                },
                HttpStatus.BAD_REQUEST,
            );
        }
        if (fields.length > 0) {
            this.activity.configChanged(
                (req.user as AuthenticatedUser).userId,
                fields,
                requestContext(req),
            );
        }
        return this.status();
    }

    @Post('admin/disable')
    @HttpCode(HttpStatus.OK)
    @UseGuards(EverIdAdminGuard)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary:
            'Turn sign-in with Ever ID off (connections, disconnect and sign-out notices keep working)',
    })
    @ApiResponse({ status: 200, description: 'The new status.' })
    @ApiResponse({ status: 404, description: 'Not a platform admin, or no identity provider.' })
    async adminDisable(@Request() req): Promise<EverIdAdminStatus> {
        await this.withProvider(() => this.facade.setEnabled(false));
        this.activity.configChanged(
            (req.user as AuthenticatedUser).userId,
            ['enabled'],
            requestContext(req),
        );
        return this.status();
    }

    private async status(): Promise<EverIdAdminStatus> {
        const [state, configuration] = await Promise.all([
            this.facade.getState(),
            this.withProvider(() => this.facade.getConfigurationStatus()),
        ]);
        return {
            enabled: state.registered && state.enabled,
            configured: configuration.configured,
            missing: configuration.missing,
            issuer: configuration.issuer,
            clientIdSet: configuration.clientIdSet,
            clientSecretSet: configuration.clientSecretSet,
            displayName: configuration.displayName,
            signUpAllowed: configuration.signUpAllowed,
            localClients: configuration.localClients,
            unavailableSince: state.unavailableSince,
            settingSources: configuration.sources,
            settings: {
                displayName: configuration.displayName,
                accountManagementUrl: configuration.accountManagementUrl,
                localClients: configuration.localClientList,
                delegatedClientNames: configuration.delegatedClientNames,
            },
        };
    }

    /** No identity provider in this build answers like a disabled one; anything else propagates. */
    private async withProvider<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            if (error instanceof IdentityProviderUnavailableError) {
                if (error.reason === 'loadFailed' || error.reason === 'unavailable') {
                    throw everIdError('providerUnavailable');
                }
                throw everIdError('everIdDisabled');
            }
            throw error;
        }
    }
}
