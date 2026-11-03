import { Module, type Type } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import { MissionsModule as AgentMissionsModule } from '@ever-works/agent/missions';
import { WorkModule } from '@ever-works/agent/services';
import { AuthModule } from '../../auth/auth.module';
import { SessionOnlyGuard } from '../../auth/guards/session-only.guard';
import { EverIdSealService } from '../../auth/services/ever-id-seal.service';
import { OrganizationsModule } from '../../organizations/organizations.module';
import { UsersModule } from '../../users/users.module';
import { EverConnectModule } from '../ever-connect.module';
import { EverConnectProvisionCallback } from './ever-connect-provision-callback.service';
import { EverConnectProvisionController } from './ever-connect-provision.controller';
import { EverConnectProvisionService } from './ever-connect-provision.service';
import { EverConnectProvisionStore } from './ever-connect-provision.store';
import { isProvisioningEnabled } from './provision.switches';

/**
 * Creating a company a person asked for in Ever. A module of its own because it
 * composes the Organization, Work, Mission and template services, which the Ever
 * Connect core has no reason to load; imported only with
 * `EVER_CONNECT_PROVISIONING_ENABLED=true` on an installation with Ever Connect
 * on ({@link everConnectProvisionModuleImports}).
 */
@Module({
    imports: [
        DatabaseModule,
        EverConnectModule,
        AuthModule,
        UsersModule,
        FacadesModule,
        OrganizationsModule,
        WorkModule,
        AgentMissionsModule,
    ],
    controllers: [EverConnectProvisionController],
    providers: [
        SessionOnlyGuard,
        // Stateless: its key comes from the platform's auth secret, as in AuthModule.
        EverIdSealService,
        EverConnectProvisionStore,
        EverConnectProvisionCallback,
        EverConnectProvisionService,
    ],
})
export class EverConnectProvisionModule {}

/**
 * What `ApiModule` imports for this: the module when switched on; otherwise, by
 * default, NOTHING: every route answers 404 like any unknown address, and no timer
 * or listener exists.
 */
export function everConnectProvisionModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isProvisioningEnabled(env) ? [EverConnectProvisionModule] : [];
}
