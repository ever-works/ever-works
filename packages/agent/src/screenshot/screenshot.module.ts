import { Module } from '@nestjs/common';
import { ScreenshotOneService } from './screenshot-one.service';

@Module({
    providers: [ScreenshotOneService],
    exports: [ScreenshotOneService],
})
export class ScreenshotModule {}
