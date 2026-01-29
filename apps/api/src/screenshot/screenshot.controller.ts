import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ScreenshotOneService, SmartImageRouterService } from '@packages/agent/screenshot';
import { DomainType } from '@packages/agent/items-generator';
import { CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '../auth/types/jwt.types';
import { AuthService } from '../auth/services/auth.service';
import {
    ValidateCredentialsDto,
    CaptureScreenshotDto,
    GetScreenshotUrlDto,
    SmartImagePreviewDto,
    SmartImagePreviewResponseDto,
} from './dto/screenshot.dto';

@ApiTags('Screenshot')
@ApiBearerAuth('JWT-auth')
@Controller('api/screenshot')
@UseGuards(JwtAuthGuard)
export class ScreenshotController {
    constructor(
        private readonly screenshotOneService: ScreenshotOneService,
        private readonly smartImageRouterService: SmartImageRouterService,
        private readonly authService: AuthService,
    ) {}

    /**
     * Validate ScreenshotOne access key and optional secret key.
     */
    @Post('/validate-credentials')
    @ApiOperation({ summary: 'Validate credentials', description: 'Validate ScreenshotOne API credentials' })
    @ApiResponse({ status: 200, description: 'Validation result' })
    async validateCredentials(@Body() dto: ValidateCredentialsDto) {
        const result = await this.screenshotOneService.validateKeys(dto.accessKey, dto.secretKey);

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
    @ApiOperation({ summary: 'Check availability', description: 'Check if screenshot service is available' })
    @ApiResponse({ status: 200, description: 'Availability status' })
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
    @ApiOperation({ summary: 'Capture screenshot', description: 'Capture a screenshot of a URL' })
    @ApiResponse({ status: 200, description: 'Screenshot captured successfully' })
    @ApiResponse({ status: 400, description: 'Screenshot capture failed or service not configured' })
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
            imageUrl: result.cacheUrl || result.imageUrl,
            cacheUrl: result.cacheUrl,
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

        const imageUrl = await this.screenshotOneService.getScreenshotUrl(
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

    /**
     * Get a smart image for a URL based on domain type.
     * Routes to product image extraction for ecommerce, screenshots for software.
     */
    @Post('/smart-preview')
    @ApiOperation({ summary: 'Smart image preview', description: 'Get a smart image for a URL based on domain type' })
    @ApiResponse({ status: 200, description: 'Smart image preview result' })
    async getSmartImagePreview(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: SmartImagePreviewDto,
    ): Promise<SmartImagePreviewResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        const domainType = (dto.domainType as DomainType) || DomainType.GENERAL;

        const result = await this.smartImageRouterService.getSmartImage({
            url: dto.url,
            domainType,
            itemName: dto.itemName,
            user,
        });

        return {
            status: result.primaryImage ? 'success' : 'error',
            primaryImage: result.primaryImage,
            source: result.source,
            confidence: result.confidence,
            error: result.error,
        };
    }
}
