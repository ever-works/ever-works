import {
    Controller,
    Post,
    Body,
    UseGuards,
    Request,
    Get,
    Put,
    Query,
    HttpCode,
    HttpStatus,
    Header,
    Logger,
    BadRequestException,
    ForbiddenException,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
    ApiBody,
    ApiQuery,
} from '@nestjs/swagger';
import { AuthService } from '../services/auth.service';
import { AnonymousAuthService } from '../services/anonymous-auth.service';
import { ClaimAccountService } from '../services/claim-account.service';
import { CaptchaVerifierService } from '../services/captcha-verifier.service';
import { ZeroFrictionFunnelService } from '@ever-works/agent/services';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';
import { RegisterDto, LoginDto, UpdatePasswordDto, ClaimAccountDto } from '../dto/auth.dto';
import { VerifyEmailDto, ForgotPasswordDto, ResetPasswordDto } from '../dto/email-verification.dto';
import { RequestMagicLinkDto, RedeemMagicLinkDto } from '../dto/magic-link.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { CreateAnonymousDto } from '../dto/anonymous.dto';
import { AuthSessionGuard } from '../guards/auth-session.guard';
import { Public } from '../decorators/public.decorator';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';
import { Inject } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { toHeaders } from '../providers/request-headers';
import { SocialAuthService } from '../services/social-auth.service';

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
    private readonly logger = new Logger(AuthController.name);

    constructor(
        private authService: AuthService,
        private readonly socialAuthService: SocialAuthService,
        private readonly anonymousAuthService: AnonymousAuthService,
        private readonly claimAccountService: ClaimAccountService,
        private readonly captchaVerifier: CaptchaVerifierService,
        private readonly funnel: ZeroFrictionFunnelService,
        private activityLogService: ActivityLogService,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
    ) {}

    /**
     * EW-617 G8 — best-effort /24 (IPv4) or /48 (IPv6) prefix for telemetry.
     * Truncating to a prefix means we never persist raw IPs in funnel events.
     */
    private truncateIp(ip: string | null): string | null {
        if (!ip) return null;
        if (ip.includes('.')) {
            const parts = ip.split('.');
            if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
            return null;
        }
        // IPv6 — keep first 3 hextets (~/48), drop the rest.
        const v6 = ip.split(':');
        if (v6.length >= 3) return `${v6[0]}:${v6[1]}:${v6[2]}::/48`;
        return null;
    }

    @Public()
    @Get('providers')
    @ApiOperation({
        summary: 'Get configured auth providers',
        description: 'Returns the currently configured authentication providers',
    })
    @ApiResponse({ status: 200, description: 'Configured auth providers' })
    getConfiguredProviders() {
        return {
            emailPassword: true,
            // 1f — Surface magic-link availability so the web login UI
            // can show / hide the "Email me a link" tab. Gated by env
            // (default off) so operators can roll it out gradually.
            magicLink: (process.env.MAGIC_LINK_ENABLED ?? 'false').toLowerCase() === 'true',
            socialProviders: this.socialAuthService.getConfiguredProviders(),
        };
    }

    @Public()
    @Post('register')
    @ApiOperation({
        summary: 'Register a new user',
        description: 'Create a new user account with email and password',
    })
    @ApiResponse({ status: 201, description: 'User successfully registered' })
    @ApiResponse({ status: 400, description: 'Invalid input or email already exists' })
    async register(@Body() registerDto: RegisterDto, @Request() req) {
        await this.authService.assertCanRegister(registerDto.email);
        const response = await this.authProvider.signUpEmail(
            registerDto.username,
            registerDto.email,
            registerDto.password,
            toHeaders(req.headers || {}),
        );

        try {
            await this.authService.sendVerificationEmail(
                response.user.id,
                registerDto.emailVerificationCallbackUrl,
            );
        } catch (error) {
            this.logger.warn(
                `Failed to send verification email for user ${response.user.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }

        return response;
    }

    @Public()
    @Post('anonymous')
    // EW-617 G2: zero-friction onboarding entrypoint. Rate-limited per IP to
    // prevent abuse; G7 layers on optional captcha when CAPTCHA_PROVIDER +
    // CAPTCHA_SECRET are configured (no-op in dev).
    @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Create an anonymous (zero-friction) user',
        description:
            'Mints a temporary User row + session token. The row + its Works are wiped automatically after ANONYMOUS_USER_TTL_DAYS (default 7) days unless the user calls POST /api/auth/claim first.',
    })
    @ApiResponse({ status: 201, description: 'Anonymous session issued' })
    @ApiResponse({ status: 400, description: 'Captcha verification failed' })
    @ApiResponse({ status: 429, description: 'Rate limit exceeded for this IP' })
    async anonymous(@Request() req, @Body() body?: CreateAnonymousDto) {
        const ipAddress =
            (typeof req.ip === 'string' && req.ip) ||
            (typeof req.headers['x-forwarded-for'] === 'string'
                ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
                : null);
        const userAgent =
            typeof req.headers['user-agent'] === 'string'
                ? (req.headers['user-agent'] as string)
                : null;

        // EW-617 G7: captcha gate. The verifier no-ops when CAPTCHA_PROVIDER
        // is unset (dev/preview).
        //
        // H-05: in production, captcha is REQUIRED. If `CAPTCHA_PROVIDER` is
        // unset in production, fail-closed rather than silently allowing
        // unauthenticated row-creation traffic.
        if (this.captchaVerifier.isRequired() && !this.captchaVerifier.isEnabled()) {
            throw new BadRequestException(
                'anonymous flow disabled: captcha is required in production but CAPTCHA_PROVIDER is not configured',
            );
        }
        if (this.captchaVerifier.isEnabled()) {
            const result = await this.captchaVerifier.verify({
                token: body?.captchaToken,
                remoteIp: ipAddress,
            });
            if (!result.success) {
                throw new BadRequestException('captcha verification failed');
            }
        }

        const response = await this.anonymousAuthService.createAnonymousUser({
            ipAddress,
            userAgent,
        });

        this.activityLogService
            .log({
                userId: response.user.id,
                actionType: ActivityActionType.USER_LOGIN,
                action: 'user.anonymous_created',
                status: ActivityStatus.COMPLETED,
                summary: 'Anonymous user created (zero-friction flow)',
                ipAddress,
                userAgent,
            })
            .catch(() => {});

        // EW-617 G8 — funnel step 2: anon-user created.
        if (body?.correlationId) {
            this.funnel.emit({
                event: ZERO_FRICTION_FUNNEL_EVENTS.ANON_USER_CREATED,
                funnelStep: 2,
                timestamp: new Date().toISOString(),
                correlationId: body.correlationId,
                anonUserId: response.user.id,
                anonymousExpiresAt: String(response.user.anonymousExpiresAt ?? ''),
                ipPrefix: this.truncateIp(ipAddress),
            });
        }

        return response;
    }

    @UseGuards(AuthSessionGuard)
    @Post('claim')
    // EW-617 G3: convert an anonymous user (G2) into a regular account.
    // Throttled to dampen brute-force attempts at squatting taken emails.
    @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } })
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Claim an anonymous account',
        description:
            'Converts an anonymous (zero-friction) account into a regular credentialed account. Attaches email + password, clears the TTL, fires verification email. The bearer token from POST /api/auth/anonymous stays valid.',
    })
    @ApiResponse({ status: 200, description: 'Account claimed, verification email sent' })
    @ApiResponse({ status: 403, description: 'Account is not anonymous' })
    @ApiResponse({
        status: 409,
        description: 'Email already in use by a different account',
    })
    async claimAccount(@Request() req, @Body() claimDto: ClaimAccountDto) {
        const userId = req.user?.userId;
        if (!userId) {
            return { message: 'unauthorized' };
        }

        // L-05: explicit anonymous-only guard at the controller layer. The
        // downstream `claimAccountService.claim` does check `user.isAnonymous`,
        // but pinning the rule at the controller surface keeps the contract
        // visible in the OpenAPI doc and protects against a future refactor
        // that loses the service-side check.
        if (req.user?.isAnonymous !== true) {
            throw new ForbiddenException(
                'claim is only valid for anonymous (zero-friction) accounts',
            );
        }

        const claimed = await this.claimAccountService.claim({
            userId,
            email: claimDto.email,
            password: claimDto.password,
            username: claimDto.username,
            emailVerificationCallbackUrl: claimDto.emailVerificationCallbackUrl,
        });

        const ipAddress =
            (typeof req.ip === 'string' && req.ip) ||
            (typeof req.headers['x-forwarded-for'] === 'string'
                ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
                : null);
        const userAgent =
            typeof req.headers['user-agent'] === 'string'
                ? (req.headers['user-agent'] as string)
                : null;

        this.activityLogService
            .log({
                userId: claimed.id,
                actionType: ActivityActionType.USER_LOGIN,
                action: 'user.account_claimed',
                status: ActivityStatus.COMPLETED,
                summary: 'Anonymous user claimed account',
                ipAddress,
                userAgent,
            })
            .catch(() => {});

        // EW-617 G8 — funnel step 8: claim-account (anon → registered).
        if (claimDto.correlationId) {
            this.funnel.emit({
                event: ZERO_FRICTION_FUNNEL_EVENTS.CLAIM_ACCOUNT,
                funnelStep: 8,
                timestamp: new Date().toISOString(),
                correlationId: claimDto.correlationId,
                userId: claimed.id,
                viaZeroFriction: true,
            });
        }

        return claimed;
    }

    // H-17 (partial): per-endpoint throttle on the credential-validation
    // path. Defaults derived from the audit's "credential stuffing wide open
    // under 50 req/sec/IP" finding — 10/min/IP is permissive enough for a real
    // user fat-fingering their password but stops a brute-force loop dead.
    // Overridable via env vars:
    //   LOGIN_THROTTLE_LIMIT  (default 10)
    //   LOGIN_THROTTLE_TTL_MS (default 60_000)
    // NOTE: these env vars are read once at module load (class-decoration
    // time), NOT per-request — changes require an API restart to take effect.
    // Env tightening is meant for the next deploy, not live attack tuning;
    // for live tuning we'd need a runtime-configurable throttler (deferred
    // alongside the H-17/H-18 Redis work). A per-user lockout (vs IP
    // throttle) needs an additional DB-backed counter; that's also deferred.
    @Public()
    @Throttle({
        default: {
            limit: Number(process.env.LOGIN_THROTTLE_LIMIT ?? 10),
            ttl: Number(process.env.LOGIN_THROTTLE_TTL_MS ?? 60_000),
        },
    })
    @Post('login')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'User login', description: 'Authenticate with email and password' })
    @ApiBody({ type: LoginDto })
    @ApiResponse({
        status: 200,
        description: 'Successfully authenticated, returns a bearer token',
    })
    @ApiResponse({ status: 401, description: 'Invalid credentials' })
    async login(@Request() req, @Body() loginDto: LoginDto) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        const result = await this.authProvider.signInEmail(
            loginDto.email,
            loginDto.password,
            toHeaders(req.headers || {}),
        );
        this.activityLogService
            .log({
                userId: result.user.id,
                actionType: ActivityActionType.USER_LOGIN,
                action: 'user.login',
                status: ActivityStatus.COMPLETED,
                summary: 'Signed in',
                ipAddress,
                userAgent,
            })
            .catch(() => {});
        return result;
    }

    @UseGuards(AuthSessionGuard)
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Logout',
        description: 'Invalidate the current authenticated session',
    })
    @ApiResponse({ status: 200, description: 'Successfully logged out' })
    async logout(@Request() req) {
        await this.authProvider.signOut(toHeaders(req.headers || {}));

        return { message: 'Logged out successfully' };
    }

    @UseGuards(AuthSessionGuard)
    @Post('logout-all')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Logout from all devices',
        description: 'Invalidate all sessions for the user',
    })
    @ApiResponse({ status: 200, description: 'Successfully logged out from all devices' })
    async logoutAll(@Request() req) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        await this.authProvider.signOutAll(req.user.userId);
        // L-03: forensic audit-log entry for a fleet-wide sign-out. Useful
        // when investigating "all my sessions were killed" support tickets
        // or correlating the event with a suspicious login from a new IP.
        this.activityLogService
            .log({
                userId: req.user.userId,
                actionType: ActivityActionType.USER_LOGIN,
                action: 'user.logout_all',
                status: ActivityStatus.COMPLETED,
                summary: 'Signed out from all devices',
                ipAddress,
                userAgent,
            })
            .catch(() => {});
        return { message: 'Logged out from all devices successfully' };
    }

    @UseGuards(AuthSessionGuard)
    @Get('profile')
    @Header('Cache-Control', 'private, no-store')
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Get current user profile',
        description: 'Returns the authenticated user profile from JWT',
    })
    @ApiResponse({ status: 200, description: 'User profile data' })
    async getProfile(@Request() req) {
        // Public API canonical user shape uses `id` (matches UserProfile on the
        // web client), but `req.user` is `AuthenticatedUser` which carries
        // `userId`. Expose both for backwards compatibility.
        return { id: req.user.userId, ...req.user };
    }

    @UseGuards(AuthSessionGuard)
    @Get('profile/fresh')
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Get fresh user profile',
        description: 'Returns fresh user data from the database',
    })
    @ApiResponse({ status: 200, description: 'Fresh user profile data' })
    async getFreshProfile(@Request() req) {
        // Get fresh user data from database
        return this.authService.getUserProfile(req.user.userId);
    }

    @UseGuards(AuthSessionGuard)
    @Post('update-password')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'Update password', description: 'Change the user password' })
    @ApiResponse({ status: 200, description: 'Password successfully updated' })
    @ApiResponse({ status: 400, description: 'Current password is incorrect' })
    async updatePassword(@Request() req, @Body() updatePasswordDto: UpdatePasswordDto) {
        await this.authProvider.changePassword(
            updatePasswordDto.currentPassword,
            updatePasswordDto.newPassword,
            toHeaders(req.headers || {}),
        );
        return { message: 'Password updated successfully' };
    }

    @UseGuards(AuthSessionGuard)
    @Put('profile')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Update user profile',
        description: 'Update user profile information',
    })
    @ApiResponse({ status: 200, description: 'Profile successfully updated' })
    async updateProfile(@Request() req, @Body() updateProfileDto: UpdateProfileDto) {
        return this.authService.updateUserProfile(req.user.userId, updateProfileDto);
    }

    @UseGuards(AuthSessionGuard)
    @Post('send-verification')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Send verification email',
        description: 'Send an email verification link to the user',
    })
    @ApiResponse({ status: 200, description: 'Verification email sent' })
    async sendVerification(@Request() req) {
        return this.authService.sendVerificationEmail(req.user.userId);
    }

    @Public()
    @Post('verify-email')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Verify email',
        description: 'Verify email address using the token from the verification email',
    })
    @ApiResponse({ status: 200, description: 'Email verified successfully and session issued' })
    @ApiResponse({ status: 400, description: 'Invalid or expired token' })
    async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto, @Request() req) {
        const user = await this.authService.verifyEmail(verifyEmailDto.token);
        // H-04: bind the new session to the requesting client.
        const ipAddress =
            (typeof req.ip === 'string' && req.ip) ||
            (typeof req.headers['x-forwarded-for'] === 'string'
                ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
                : null);
        const userAgent =
            typeof req.headers['user-agent'] === 'string'
                ? (req.headers['user-agent'] as string)
                : null;
        return this.authProvider.issueSession(user.id, { ipAddress, userAgent });
    }

    @Public()
    @Post('forgot-password')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Forgot password', description: 'Request a password reset email' })
    @ApiResponse({ status: 200, description: 'Password reset email sent if email exists' })
    async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
        return this.authService.forgotPassword(forgotPasswordDto);
    }

    @Public()
    @Post('reset-password')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Reset password',
        description: 'Reset password using the token from the reset email',
    })
    @ApiResponse({ status: 200, description: 'Password reset successfully' })
    @ApiResponse({ status: 400, description: 'Invalid or expired token' })
    async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
        const user = await this.authService.getUserByPasswordResetToken(resetPasswordDto.token);
        await this.authProvider.setPassword(user.id, resetPasswordDto.newPassword);
        await this.authService.consumePasswordResetToken(resetPasswordDto.token);
        await this.authProvider.signOutAll(user.id);
        return { message: 'Password reset successfully' };
    }

    // M-20: tight throttle on token-validity oracles. The token space is large
    // (256 bits of entropy), so brute-force is infeasible — but a leaked log
    // line or DB peek combined with an unrestricted validity oracle would let
    // an attacker confirm token guesses cheaply. 10/min/IP closes that side-channel.
    @Public()
    @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
    @Get('validate-email-token')
    @ApiOperation({
        summary: 'Validate email verification token',
        description: 'Check if an email verification token is valid',
    })
    @ApiQuery({ name: 'token', required: true, description: 'The verification token' })
    @ApiResponse({ status: 200, description: 'Token is valid' })
    @ApiResponse({ status: 400, description: 'Token is invalid or expired' })
    async validateEmailVerificationToken(@Query('token') token: string) {
        if (!token || token.trim().length === 0) {
            throw new BadRequestException('token query parameter is required');
        }
        return this.authService.validateEmailVerificationToken(token);
    }

    @Public()
    @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
    @Get('validate-reset-token')
    @ApiOperation({
        summary: 'Validate password reset token',
        description: 'Check if a password reset token is valid',
    })
    @ApiQuery({ name: 'token', required: true, description: 'The reset token' })
    @ApiResponse({ status: 200, description: 'Token is valid' })
    @ApiResponse({ status: 400, description: 'Token is invalid or expired' })
    async validatePasswordResetToken(@Query('token') token: string) {
        if (!token || token.trim().length === 0) {
            throw new BadRequestException('token query parameter is required');
        }
        return this.authService.validatePasswordResetToken(token);
    }

    /**
     * 1f — Magic-link issuance. Public endpoint, intentionally returns
     * the same response shape for "email exists" and "email unknown"
     * to prevent enumeration. Rate-limited tighter than the global cap
     * because an issuance burst is the natural setup for a token-
     * brute-force attempt against the redeem endpoint below.
     */
    @Public()
    @Throttle({ default: { limit: 5, ttl: 60 * 1000 } })
    @Post('magic-link')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Request a magic login link',
        description:
            'Generates a one-time login link and emails it to the supplied address. Response is identical regardless of whether the email exists.',
    })
    @ApiResponse({ status: 200, description: 'Issuance accepted' })
    async requestMagicLink(@Body() dto: RequestMagicLinkDto) {
        return this.authService.requestMagicLink(dto);
    }

    /**
     * 1f — Magic-link redemption. Public endpoint. Invalid or expired
     * tokens always 400 with a uniform message — never disclose
     * whether the token shape was wrong vs the token didn't match a
     * user. Rate-limited at 10/min/IP so a leaked log line can't be
     * combined with cheap brute-force.
     */
    @Public()
    @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
    @Post('magic-link/redeem')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Redeem a magic link and issue a session',
        description: 'Consumes the magic-link token and returns a session token + user profile.',
    })
    @ApiResponse({ status: 200, description: 'Session issued' })
    @ApiResponse({ status: 400, description: 'Invalid or expired token' })
    async redeemMagicLink(@Body() dto: RedeemMagicLinkDto, @Request() req) {
        const user = await this.authService.redeemMagicLink(dto.token);
        const ipAddress =
            (typeof req.ip === 'string' && req.ip) ||
            (typeof req.headers['x-forwarded-for'] === 'string'
                ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
                : null);
        const userAgent =
            typeof req.headers['user-agent'] === 'string'
                ? (req.headers['user-agent'] as string)
                : null;
        return this.authProvider.issueSession(user.id, { ipAddress, userAgent });
    }
}
