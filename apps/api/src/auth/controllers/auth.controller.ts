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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AuthService } from '../services/auth.service';
import { UpdatePasswordDto } from '../dto/auth.dto';
import { VerifyEmailDto, ForgotPasswordDto, ResetPasswordDto } from '../dto/email-verification.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { SessionAuthGuard } from '../guards/session-auth.guard';
import { Public } from '../decorators/public.decorator';
import { config } from '@src/config/constants';
import { AuthProviderService } from '../services/auth-provider.service';
import type { Request as ExpressRequest } from 'express';

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
    constructor(
        private authService: AuthService,
        private authProviderService: AuthProviderService,
    ) {}

    private createForwardedHeaders(req: ExpressRequest): Headers {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (value) {
                headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
            }
        }
        return headers;
    }

    @Public()
    @Get('providers')
    @ApiOperation({
        summary: 'Get configured auth providers',
        description: 'Returns the authentication methods currently enabled for the app',
    })
    @ApiResponse({ status: 200, description: 'Configured authentication providers' })
    getProviders() {
        const socialProviders = [
            config.github.clientId() && config.github.clientSecret() ? 'github' : null,
            config.google.clientId() && config.google.clientSecret() ? 'google' : null,
            config.linkedin.clientId() && config.linkedin.clientSecret() ? 'linkedin' : null,
            config.facebook.clientId() && config.facebook.clientSecret() ? 'facebook' : null,
            config.twitter.clientId() && config.twitter.clientSecret() ? 'twitter' : null,
        ].filter((provider): provider is string => !!provider);

        return {
            emailPassword: true,
            socialProviders,
        };
    }

    @UseGuards(SessionAuthGuard)
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'Logout', description: 'Logout the current authenticated session' })
    @ApiResponse({ status: 200, description: 'Successfully logged out' })
    async logout(@Request() req) {
        await this.authProviderService.api.signOut({
            headers: this.createForwardedHeaders(req),
        });
        return { message: 'Logged out successfully' };
    }

    @UseGuards(SessionAuthGuard)
    @Post('logout-all')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({
        summary: 'Logout from all devices',
        description: 'Logout from all active sessions for the user',
    })
    @ApiResponse({ status: 200, description: 'Successfully logged out from all devices' })
    async logoutAll(@Request() req) {
        await this.authProviderService.api.revokeOtherSessions({
            headers: this.createForwardedHeaders(req),
        });
        return { message: 'Logged out from all devices successfully' };
    }

    @UseGuards(SessionAuthGuard)
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

    @UseGuards(SessionAuthGuard)
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

    @UseGuards(SessionAuthGuard)
    @Post('update-password')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth('JWT-auth')
    @ApiOperation({ summary: 'Update password', description: 'Change the user password' })
    @ApiResponse({ status: 200, description: 'Password successfully updated' })
    @ApiResponse({ status: 400, description: 'Current password is incorrect' })
    async updatePassword(@Request() req, @Body() updatePasswordDto: UpdatePasswordDto) {
        return this.authService.updatePassword(req.user.userId, updatePasswordDto);
    }

    @UseGuards(SessionAuthGuard)
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

    @UseGuards(SessionAuthGuard)
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
