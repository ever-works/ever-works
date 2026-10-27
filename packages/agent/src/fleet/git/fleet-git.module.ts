import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GitHubAppInstallation } from '../../entities/github-app-installation.entity';
import { GitHubAppInstallationRepository as GitHubAppInstallationRepositoryEntity } from '../../entities/github-app-installation-repository.entity';
import { GitHubAppUserLink } from '../../entities/github-app-user-link.entity';
import { User } from '../../entities/user.entity';
import { FleetModule } from '../fleet.module';
import { FleetGitIdentityService } from './fleet-git-identity.service';

/**
 * Tasks on computers (FL-15 P2) — the agent-side module of a computer's git
 * identity: `FleetGitIdentityService`, which the API routes and the Agent tools
 * call. The node transport is the `FLEET_MACHINE_NODE_PORT` the API binds
 * (FL-09's global `FleetMachineApiModule`; unbound, every computer reads
 * `unreachable`). Nothing is stored: the identity is read from the machine;
 * the only write is `fleet_audit` through `FleetModule`'s `FleetAuditService`.
 */
@Module({
    imports: [
        FleetModule,
        TypeOrmModule.forFeature([
            User,
            GitHubAppUserLink,
            GitHubAppInstallation,
            GitHubAppInstallationRepositoryEntity,
        ]),
    ],
    providers: [FleetGitIdentityService],
    exports: [FleetGitIdentityService],
})
export class FleetGitModule {}
