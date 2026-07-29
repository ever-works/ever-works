import { Module } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { AuthModule } from '../../auth/auth.module';
import { TranscriptionController } from './transcription.controller';

@Module({
    imports: [FacadesModule, AuthModule],
    controllers: [TranscriptionController],
})
export class TranscriptionModule {}
