import { Module } from '@nestjs/common';
import { FacadesModule } from '@packages/agent/facades';
import { DatabaseModule } from '@packages/agent/database';
import { GitProviderController } from './git-provider.controller';
import { GitProviderService } from './git-provider.service';

@Module({
    imports: [FacadesModule, DatabaseModule],
    controllers: [GitProviderController],
    providers: [GitProviderService],
    exports: [GitProviderService],
})
export class GitProviderModule {}
