import { Module } from '@nestjs/common';
import { ScreenshotController } from './screenshot.controller';
import { FacadesModule } from '@ever-works/agent/facades';
// Security (EW-711 #30): WorkModule provides/exports WorkOwnershipService so
// the controller can authorize a supplied workId before reading its scoped
// providers/secrets or spending its credits.
import { WorkModule } from '@ever-works/agent/services';
import { AuthModule } from '../../auth/auth.module';

@Module({
    imports: [FacadesModule, WorkModule, AuthModule],
    controllers: [ScreenshotController],
})
export class ScreenshotModule {}
