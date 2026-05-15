import { Module, forwardRef } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { WebsiteGeneratorModule } from '@ever-works/agent/generators';
import { WorkModule } from '@ever-works/agent/services';
import { AuthModule } from '../../auth/auth.module';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { EverWorksDnsService } from '@ever-works/agent/ever-works-providers';
import { DeployController } from './deploy.controller';
import { DeployService } from './deploy.service';
import { DeploymentVerifierService } from './tasks/deployment-verifier.service';

@Module({
    imports: [
        FacadesModule,
        DatabaseModule,
        WebsiteGeneratorModule,
        WorkModule,
        ActivityLogModule,
        forwardRef(() => AuthModule),
    ],
    controllers: [DeployController],
    providers: [DeployService, DeploymentVerifierService, EverWorksDnsService],
    exports: [DeployService, DeploymentVerifierService],
})
export class DeployModule {}
