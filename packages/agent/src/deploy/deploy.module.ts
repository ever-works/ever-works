import { Module } from '@nestjs/common';
import { VercelService } from './vercel.service';
import { FacadesModule } from '../facades/facades.module';
import { WebsiteGeneratorModule } from '../generators/website-generator/website-generator.module';
import { DatabaseModule } from '../database/database.module';
import { BatchDeployService } from './batch-deploy.service';
import { PluginsModule } from '../plugins/plugins.module';

@Module({
    imports: [DatabaseModule, FacadesModule, WebsiteGeneratorModule, PluginsModule],
    providers: [VercelService, BatchDeployService],
    exports: [VercelService, BatchDeployService],
})
export class DeployModule {}
