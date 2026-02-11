import { Module } from '@nestjs/common';
import { WebsiteGeneratorService } from './website-generator.service';
import { WebsiteUpdateService } from './website-update.service';
import { BranchSyncService } from './branch-sync.service';
import { FacadesModule } from '../../facades/facades.module';

@Module({
    imports: [FacadesModule],
    providers: [WebsiteGeneratorService, WebsiteUpdateService, BranchSyncService],
    exports: [WebsiteGeneratorService, WebsiteUpdateService, BranchSyncService],
})
export class WebsiteGeneratorModule {}
