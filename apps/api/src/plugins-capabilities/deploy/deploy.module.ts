import { Module, forwardRef } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { WebsiteGeneratorModule } from '@ever-works/agent/generators';
import { WorkModule } from '@ever-works/agent/services';
import { AuthModule } from '../../auth/auth.module';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import {
    EverWorksDnsService,
    EverWorksK8sDeployProvider,
    SubdomainAllocator,
    EverWorksDbProvisionService,
} from '@ever-works/agent/ever-works-providers';
import { DeployController } from './deploy.controller';
import { DeployService } from './deploy.service';
import { DeploymentVerifierService } from './tasks/deployment-verifier.service';
import { ManagedSubdomainService } from './managed-subdomain.service';

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
    providers: [
        DeployService,
        DeploymentVerifierService,
        EverWorksDnsService,
        // Task 10 / Path A — dedicated managed-deploy provider, registered so
        // it is part of the deploy module's DI graph (it was registered
        // nowhere). The facade resolves `deployProvider === 'ever-works'`
        // credentials through it (reading `EVER_WORKS_DEPLOY_*`).
        EverWorksK8sDeployProvider,
        SubdomainAllocator,
        ManagedSubdomainService,
        EverWorksDbProvisionService,
    ],
    exports: [DeployService, DeploymentVerifierService, ManagedSubdomainService],
})
export class DeployModule {}
