import { Module } from '@nestjs/common';
import { VercelService } from './vercel.service';
import { FacadesModule } from '../facades/facades.module';
import { WebsiteGeneratorModule } from '../generators/website-generator/website-generator.module';
import { DatabaseModule } from '../database/database.module';
import { BatchDeployService } from './batch-deploy.service';

/**
 * Deploy module for deployment services.
 *
 * Note: This module relies on PluginsModule being registered globally via forRoot()
 * at the application root level. Do not import PluginsModule directly here.
 */
@Module({
    imports: [DatabaseModule, FacadesModule, WebsiteGeneratorModule],
    providers: [VercelService, BatchDeployService],
    exports: [VercelService, BatchDeployService],
})
export class DeployModule {}
