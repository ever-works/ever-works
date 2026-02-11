import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ScreenshotFacadeService } from '@ever-works/agent/facades';
import { CurrentUser, JwtAuthGuard } from '../../auth';
import { AuthenticatedUser } from '../../auth/types/jwt.types';
import { CaptureScreenshotDto, GetScreenshotUrlDto } from './dto/screenshot.dto';

@ApiTags('Screenshot')
@ApiBearerAuth('JWT-auth')
@Controller('api/screenshot')
@UseGuards(JwtAuthGuard)
export class ScreenshotController {
    constructor(private readonly screenshotFacade: ScreenshotFacadeService) {}

    @Get('/check-availability')
    @ApiOperation({ summary: 'Check availability' })
    @ApiResponse({ status: 200, description: 'Availability status' })
    async checkAvailability(@CurrentUser() auth: AuthenticatedUser) {
        const isAvailable = this.screenshotFacade.isAvailable();
        const providers = this.screenshotFacade.getAvailableProviders();

        return {
            status: 'success',
            available: isAvailable,
            providers: providers.filter((p) => p.enabled).map((p) => p.name),
        };
    }

    @Post('/capture')
    @ApiOperation({ summary: 'Capture screenshot' })
    @ApiResponse({ status: 200, description: 'Screenshot captured successfully' })
    @ApiResponse({ status: 400, description: 'Screenshot capture failed' })
    async capture(@CurrentUser() auth: AuthenticatedUser, @Body() dto: CaptureScreenshotDto) {
        if (!this.screenshotFacade.isAvailable()) {
            throw new BadRequestException({
                status: 'error',
                message: 'No screenshot provider configured',
            });
        }

        const result = await this.screenshotFacade.capture(
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
            { userId: auth.userId },
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
            imageBase64: result.imageBuffer ? result.imageBuffer.toString('base64') : null,
        };
    }

    @Post('/get-url')
    @ApiOperation({ summary: 'Get screenshot URL' })
    async getScreenshotUrl(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: GetScreenshotUrlDto,
    ) {
        if (!this.screenshotFacade.isAvailable()) {
            throw new BadRequestException({
                status: 'error',
                message: 'No screenshot provider configured',
            });
        }

        const imageUrl = await this.screenshotFacade.getScreenshotUrl(
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
            { userId: auth.userId },
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
