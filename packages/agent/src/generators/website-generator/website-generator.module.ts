import { Module } from '@nestjs/common';
import { WebsiteGeneratorService } from './website-generator.service';
import { WebsiteUpdateService } from './website-update.service';
import { BranchSyncService } from './branch-sync.service';
import { FacadesModule } from '../../facades/facades.module';
import { DatabaseModule } from '../../database/database.module';
import { WebsiteTemplateResolverService } from './website-template-resolver.service';

@Module({
    imports: [FacadesModule, DatabaseModule],
    providers: [
        WebsiteGeneratorService,
        WebsiteUpdateService,
        BranchSyncService,
        WebsiteTemplateResolverService,
    ],
    exports: [
        WebsiteGeneratorService,
        WebsiteUpdateService,
        BranchSyncService,
        WebsiteTemplateResolverService,
    ],
})
export class WebsiteGeneratorModule {}
