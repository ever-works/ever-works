import { Module } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '../../auth/auth.module';
import { GitProviderController } from './git-provider.controller';
import { GitProviderService } from './git-provider.service';

@Module({
    imports: [FacadesModule, DatabaseModule, AuthModule],
    controllers: [GitProviderController],
    providers: [GitProviderService],
    exports: [GitProviderService],
})
export class GitProviderModule {}
