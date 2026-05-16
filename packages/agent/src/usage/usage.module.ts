import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { PluginUsageService } from './plugin-usage.service';

/**
 * EW-602 — wires the per-call usage recording service backed by
 * PluginUsageRepository (provided by DatabaseModule). Imported by
 * FacadesModule so each capability facade can record events.
 */
@Module({
    imports: [DatabaseModule],
    providers: [PluginUsageService],
    exports: [PluginUsageService],
})
export class UsageModule {}
