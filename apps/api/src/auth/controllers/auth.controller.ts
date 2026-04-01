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
import { RegisterDto, LoginDto, RefreshTokenDto, UpdatePasswordDto } from '../dto/auth.dto';
import { VerifyEmailDto, ForgotPasswordDto, ResetPasswordDto } from '../dto/email-verification.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { LocalAuthGuard } from '../guards/local-auth.guard';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Public } from '../decorators/public.decorator';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
    constructor(
        private authService: AuthService,
        private activityLogService: ActivityLogService,
    ) {}

    @Public()
    @Post('register')
    @ApiOperation({
        summary: 'Register a new user',
        description: 'Create a new user account with email and password',
    })
    @ApiResponse({ status: 201, description: 'User successfully registered' })
    @ApiResponse({ status: 400, description: 'Invalid input or email already exists' })
    async register(@Body() registerDto: RegisterDto) {
        return this.authService.register(registerDto);
    }

    @Public()
    @UseGuards(LocalAuthGuard)
    @Post('login')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'User login', description: 'Authenticate with email and password' })
    @ApiBody({ type: LoginDto })
    @ApiResponse({
        status: 200,
        description: 'Successfully authenticated, returns access and refresh tokens',
    })
    @ApiResponse({ status: 401, description: 'Invalid credentials' })
    async login(@Request() req) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        const result = await this.authService.login(req.user, userAgent, ipAddress);
        this.activityLogService
            .log({
                userId: req.user.id,
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

    @Public()
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Refresh access token',
        description: 'Get a new access token using a refresh token',
    })
    @ApiResponse({ status: 200, description: 'New access token generated' })
    @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
    async refresh(@Request() req, @Body() refreshTokenDto: RefreshTokenDto) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        return this.authService.refreshToken(refreshTokenDto.refreshToken, userAgent, ipAddress);
    }

    @UseGuards(JwtAuthGuard)
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'Logout', description: 'Invalidate the current refresh token' })
    @ApiResponse({ status: 200, description: 'Successfully logged out' })
    async logout(@Body() refreshTokenDto: RefreshTokenDto) {
        return this.authService.logout(refreshTokenDto.refreshToken);
    }

    @UseGuards(JwtAuthGuard)
    @Post('logout-all')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Logout from all devices',
        description: 'Invalidate all refresh tokens for the user',
    })
    @ApiResponse({ status: 200, description: 'Successfully logged out from all devices' })
    async logoutAll(@Request() req) {
        return this.authService.logoutAllDevices(req.user.userId);
    }

    @UseGuards(JwtAuthGuard)
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

    @UseGuards(JwtAuthGuard)
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

    @UseGuards(JwtAuthGuard)
    @Post('update-password')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'Update password', description: 'Change the user password' })
    @ApiResponse({ status: 200, description: 'Password successfully updated' })
    @ApiResponse({ status: 400, description: 'Current password is incorrect' })
    async updatePassword(@Request() req, @Body() updatePasswordDto: UpdatePasswordDto) {
        return this.authService.updatePassword(req.user.userId, updatePasswordDto);
    }

    @UseGuards(JwtAuthGuard)
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

    @UseGuards(JwtAuthGuard)
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
    @ApiResponse({ status: 200, description: 'Email verified successfully' })
    @ApiResponse({ status: 400, description: 'Invalid or expired token' })
    async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
        return this.authService.verifyEmail(verifyEmailDto.token);
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
        return this.authService.resetPassword(resetPasswordDto.token, resetPasswordDto.newPassword);
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
