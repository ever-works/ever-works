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
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from '../services/auth.service';
import { OAuthUrlService } from '../services/oauth-url.service';
import { RegisterDto, RefreshTokenDto, UpdatePasswordDto } from '../dto/auth.dto';
import { VerifyEmailDto, ForgotPasswordDto, ResetPasswordDto } from '../dto/email-verification.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { LocalAuthGuard } from '../guards/local-auth.guard';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Public } from '../decorators/public.decorator';
import { AuthProvider } from '../../config/constants';

@Controller('api/auth')
export class AuthController {
    constructor(
        private authService: AuthService,
        private oauthUrlService: OAuthUrlService,
    ) {}

    @Public()
    @Post('register')
    async register(@Body() registerDto: RegisterDto) {
        return this.authService.register(registerDto);
    }

    @Public()
    @UseGuards(LocalAuthGuard)
    @Post('login')
    @HttpCode(HttpStatus.OK)
    async login(@Request() req) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        return this.authService.login(req.user, userAgent, ipAddress);
    }

    @Public()
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    async refresh(@Request() req, @Body() refreshTokenDto: RefreshTokenDto) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        return this.authService.refreshToken(refreshTokenDto.refreshToken, userAgent, ipAddress);
    }

    @UseGuards(JwtAuthGuard)
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    async logout(@Body() refreshTokenDto: RefreshTokenDto) {
        return this.authService.logout(refreshTokenDto.refreshToken);
    }

    @UseGuards(JwtAuthGuard)
    @Post('logout-all')
    @HttpCode(HttpStatus.OK)
    async logoutAll(@Request() req) {
        return this.authService.logoutAllDevices(req.user.userId);
    }

    @UseGuards(JwtAuthGuard)
    @Get('profile')
    async getProfile(@Request() req) {
        return req.user;
    }

    @UseGuards(JwtAuthGuard)
    @Get('profile/fresh')
    async getFreshProfile(@Request() req) {
        // Get fresh user data from database
        return this.authService.getUserProfile(req.user.userId);
    }

    @UseGuards(JwtAuthGuard)
    @Post('update-password')
    @HttpCode(HttpStatus.OK)
    async updatePassword(@Request() req, @Body() updatePasswordDto: UpdatePasswordDto) {
        return this.authService.updatePassword(req.user.userId, updatePasswordDto);
    }

    @UseGuards(JwtAuthGuard)
    @Put('profile')
    @HttpCode(HttpStatus.OK)
    async updateProfile(@Request() req, @Body() updateProfileDto: UpdateProfileDto) {
        return this.authService.updateUserProfile(req.user.userId, updateProfileDto);
    }

    @Public()
    @Get('github/url')
    async getGitHubAuthUrl(
        @Query('callbackUrl') callbackUrl?: string,
        @Query('state') state?: string,
    ) {
        const url = this.oauthUrlService.generateGitHubAuthUrl(callbackUrl, state);
        return { url };
    }

    @Public()
    @Get('google/url')
    async getGoogleAuthUrl(
        @Query('callbackUrl') callbackUrl?: string,
        @Query('state') state?: string,
    ) {
        const url = this.oauthUrlService.generateGoogleAuthUrl(callbackUrl, state);
        return { url };
    }

    @Public()
    @Get('github')
    @UseGuards(AuthGuard(AuthProvider.GITHUB))
    async githubAuth(@Request() req) {}

    @Public()
    @Get('github/callback')
    @UseGuards(AuthGuard(AuthProvider.GITHUB))
    async githubAuthRedirect(@Request() req) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        return this.authService.login(req.user, userAgent, ipAddress);
    }

    @Public()
    @Get('google')
    @UseGuards(AuthGuard(AuthProvider.GOOGLE))
    async googleAuth(@Request() req) {}

    @Public()
    @Get('google/callback')
    @UseGuards(AuthGuard(AuthProvider.GOOGLE))
    async googleAuthRedirect(@Request() req) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        return this.authService.login(req.user, userAgent, ipAddress);
    }

    @UseGuards(JwtAuthGuard)
    @Post('send-verification')
    @HttpCode(HttpStatus.OK)
    async sendVerification(@Request() req) {
        return this.authService.sendVerificationEmail(req.user.userId);
    }

    @Public()
    @Post('verify-email')
    @HttpCode(HttpStatus.OK)
    async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
        return this.authService.verifyEmail(verifyEmailDto.token);
    }

    @Public()
    @Post('forgot-password')
    @HttpCode(HttpStatus.OK)
    async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
        return this.authService.forgotPassword(forgotPasswordDto);
    }

    @Public()
    @Post('reset-password')
    @HttpCode(HttpStatus.OK)
    async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
        return this.authService.resetPassword(resetPasswordDto.token, resetPasswordDto.newPassword);
    }

    @Public()
    @Get('validate-email-token')
    async validateEmailVerificationToken(@Query('token') token: string) {
        return this.authService.validateEmailVerificationToken(token);
    }

    @Public()
    @Get('validate-reset-token')
    async validatePasswordResetToken(@Query('token') token: string) {
        return this.authService.validatePasswordResetToken(token);
    }
}
