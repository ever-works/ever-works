import { Module } from '@nestjs/common';
import { ScreenshotOneService } from './screenshot-one.service';
import { ImageScraperService } from './image-scraper.service';
import { SmartImageRouterService } from './smart-image-router.service';

@Module({
    providers: [ScreenshotOneService, ImageScraperService, SmartImageRouterService],
    exports: [ScreenshotOneService, ImageScraperService, SmartImageRouterService],
})
export class ScreenshotModule {}
