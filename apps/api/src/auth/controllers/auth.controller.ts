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
    Logger,
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
import { RegisterDto, LoginDto, UpdatePasswordDto } from '../dto/auth.dto';
import { VerifyEmailDto, ForgotPasswordDto, ResetPasswordDto } from '../dto/email-verification.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
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
        private activityLogService: ActivityLogService,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
    ) {}

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
    // prevent abuse; G7 will layer on stricter limits + captcha when needed.
    @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Create an anonymous (zero-friction) user',
        description:
            'Mints a temporary User row + session token. The row + its Works are wiped automatically after ANONYMOUS_USER_TTL_DAYS (default 7) days unless the user calls POST /api/auth/claim first.',
    })
    @ApiResponse({ status: 201, description: 'Anonymous session issued' })
    @ApiResponse({ status: 429, description: 'Rate limit exceeded for this IP' })
    async anonymous(@Request() req) {
        const ipAddress =
            (typeof req.ip === 'string' && req.ip) ||
            (typeof req.headers['x-forwarded-for'] === 'string'
                ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
                : null);
        const userAgent =
            typeof req.headers['user-agent'] === 'string'
                ? (req.headers['user-agent'] as string)
                : null;

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

        return response;
    }

    @Public()
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
        await this.authProvider.signOutAll(req.user.userId);
        return { message: 'Logged out from all devices successfully' };
    }

    @UseGuards(AuthSessionGuard)
    @Get('profile')
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Get current user profile',
        description: 'Returns the authenticated user profile from JWT',
    })
    @ApiResponse({ status: 200, description: 'User profile data' })
    async getProfile(@Request() req) {
        return req.user;
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
    async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
        const user = await this.authService.verifyEmail(verifyEmailDto.token);
        return this.authProvider.issueSession(user.id);
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

    @Public()
    @Get('validate-email-token')
    @ApiOperation({
        summary: 'Validate email verification token',
        description: 'Check if an email verification token is valid',
    })
    @ApiQuery({ name: 'token', required: true, description: 'The verification token' })
    @ApiResponse({ status: 200, description: 'Token is valid' })
    @ApiResponse({ status: 400, description: 'Token is invalid or expired' })
    async validateEmailVerificationToken(@Query('token') token: string) {
        return this.authService.validateEmailVerificationToken(token);
    }

    @Public()
    @Get('validate-reset-token')
    @ApiOperation({
        summary: 'Validate password reset token',
        description: 'Check if a password reset token is valid',
    })
    @ApiQuery({ name: 'token', required: true, description: 'The reset token' })
    @ApiResponse({ status: 200, description: 'Token is valid' })
    @ApiResponse({ status: 400, description: 'Token is invalid or expired' })
    async validatePasswordResetToken(@Query('token') token: string) {
        return this.authService.validatePasswordResetToken(token);
    }
}
