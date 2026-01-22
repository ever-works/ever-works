import { Module } from '@nestjs/common';
import { ScreenshotController } from './screenshot.controller';
import { ScreenshotModule as AgentScreenshotModule } from '@packages/agent/screenshot';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [AgentScreenshotModule, AuthModule],
    controllers: [ScreenshotController],
})
export class ScreenshotModule {}
