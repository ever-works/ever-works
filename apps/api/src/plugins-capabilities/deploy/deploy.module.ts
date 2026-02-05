import { Module, forwardRef } from '@nestjs/common';
import { FacadesModule } from '@packages/agent/facades';
import { DatabaseModule } from '@packages/agent/database';
import { PluginsModule } from '@packages/agent/plugins';
import { WebsiteGeneratorModule } from '@packages/agent/generators';
import { DirectoryModule } from '@packages/agent/services';
import { AuthModule } from '../../auth/auth.module';
import { DeployController } from './deploy.controller';
import { DeployService } from './deploy.service';
import { DeploymentVerifierService } from './tasks/deployment-verifier.service';

@Module({
    imports: [
        FacadesModule,
        DatabaseModule,
        PluginsModule,
        WebsiteGeneratorModule,
        DirectoryModule,
        forwardRef(() => AuthModule),
    ],
    controllers: [DeployController],
    providers: [DeployService, DeploymentVerifierService],
    exports: [DeployService, DeploymentVerifierService],
})
export class DeployModule {}
