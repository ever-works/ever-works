import { Module } from '@nestjs/common';
import { ScreenshotController } from './screenshot.controller';
import { FacadesModule } from '@packages/agent/facades';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [FacadesModule, AuthModule],
    controllers: [ScreenshotController],
})
export class ScreenshotModule {}
