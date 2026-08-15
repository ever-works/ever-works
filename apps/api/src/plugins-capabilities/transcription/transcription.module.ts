import { Module } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { AuthModule } from '../../auth/auth.module';
import { PluginsModule } from '../../plugins/plugins.module';
import { TranscriptionController } from './transcription.controller';

/**
 * `PluginsModule` is imported for `PluginOperationsService`, which owns the
 * user-plugin metadata blob holding the account's chosen voice provider.
 * Neither `PluginsModule` nor anything it imports reaches back here, so this
 * stays a one-way edge.
 */
@Module({
    imports: [FacadesModule, AuthModule, PluginsModule],
    controllers: [TranscriptionController],
})
export class TranscriptionModule {}
