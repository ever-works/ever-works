import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ScreenshotOneService } from '@packages/agent/screenshot';
import { CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '../auth/types/jwt.types';
import { AuthService } from '../auth/services/auth.service';
import {
    ValidateCredentialsDto,
    CaptureScreenshotDto,
    GetScreenshotUrlDto,
} from './dto/screenshot.dto';

@Controller('api/screenshot')
@UseGuards(JwtAuthGuard)
export class ScreenshotController {
    constructor(
        private readonly screenshotOneService: ScreenshotOneService,
        private readonly authService: AuthService,
    ) {}

    /**
     * Validate a ScreenshotOne access key.
     */
    @Post('/validate-credentials')
    async validateCredentials(@Body() dto: ValidateCredentialsDto) {
        const result = await this.screenshotOneService.validateAccessKey(dto.accessKey);

        return {
            status: result.valid ? 'success' : 'error',
            valid: result.valid,
            message: result.message,
        };
    }

    /**
     * Check if the screenshot service is available for the current user.
     * Returns whether global or user-specific key is configured.
     */
    @Get('/check-availability')
    async checkAvailability(@CurrentUser() auth: AuthenticatedUser) {
        const user = await this.authService.getUser(auth.userId);

        const hasGlobalKey = this.screenshotOneService.isAvailable();
        const hasUserKey = Boolean(user?.screenshotoneAccessKey);
        const isAvailable = this.screenshotOneService.isAvailable(user);

        return {
            status: 'success',
            available: isAvailable,
            hasGlobalKey,
            hasUserKey,
        };
    }

    /**
     * Capture a screenshot of a URL.
     * Returns the image URL and optionally the image buffer.
     */
    @Post('/capture')
    async capture(@CurrentUser() auth: AuthenticatedUser, @Body() dto: CaptureScreenshotDto) {
        const user = await this.authService.getUser(auth.userId);

        if (!this.screenshotOneService.isAvailable(user)) {
            throw new BadRequestException({
                status: 'error',
                message: 'No ScreenshotOne API key configured. Please configure one in settings.',
            });
        }

        const result = await this.screenshotOneService.capture(
            {
                url: dto.url,
                viewportWidth: dto.viewportWidth,
                viewportHeight: dto.viewportHeight,
                format: dto.format,
                fullPage: dto.fullPage,
                delay: dto.delay,
                blockAds: dto.blockAds,
                blockTrackers: dto.blockTrackers,
                blockCookieBanners: dto.blockCookieBanners,
            },
            user,
        );

        if (!result.success) {
            throw new BadRequestException({
                status: 'error',
                message: result.error || 'Failed to capture screenshot',
            });
        }

        return {
            status: 'success',
            imageUrl: result.imageUrl,
            // Convert buffer to base64 for JSON response
            imageBase64: result.imageBuffer ? result.imageBuffer.toString('base64') : null,
        };
    }

    /**
     * Get the direct URL for a screenshot without capturing it.
     * Useful for embedding in img tags.
     */
    @Post('/get-url')
    async getScreenshotUrl(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: GetScreenshotUrlDto,
    ) {
        const user = await this.authService.getUser(auth.userId);

        if (!this.screenshotOneService.isAvailable(user)) {
            throw new BadRequestException({
                status: 'error',
                message: 'No ScreenshotOne API key configured. Please configure one in settings.',
            });
        }

        const imageUrl = this.screenshotOneService.getScreenshotUrl(
            {
                url: dto.url,
                viewportWidth: dto.viewportWidth,
                viewportHeight: dto.viewportHeight,
                format: dto.format,
                fullPage: dto.fullPage,
                delay: dto.delay,
                blockAds: dto.blockAds,
                blockTrackers: dto.blockTrackers,
                blockCookieBanners: dto.blockCookieBanners,
            },
            user,
        );

        if (!imageUrl) {
            throw new BadRequestException({
                status: 'error',
                message: 'Failed to generate screenshot URL',
            });
        }

        return {
            status: 'success',
            imageUrl,
        };
    }
}
