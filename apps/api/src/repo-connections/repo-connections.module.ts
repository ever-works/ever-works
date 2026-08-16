import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { AgentsModule } from '@ever-works/agent/agents';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { RepoRegistryService } from '@ever-works/agent/services';
import { RepoConnectionsController } from './repo-connections.controller';
import { AgentReposController } from './agent-repos.controller';

/**
 * Repository registry (Feature G) — Settings → Repositories backend.
 *
 * `RepoRegistryService` lives in `@ever-works/agent/services` (domain
 * package) and is PROVIDED here: its dependencies are the DatabaseModule
 * repositories (repo connections, attachments, works, GitHub-App
 * mirror) plus `AgentRepository`, which is feature-owned and exported by
 * the agent-side `AgentsModule` — imported here exactly the way the
 * api-side AgentsModule imports it (modules are singletons, so this adds
 * a reference, not a second instance).
 */
@Module({
    // ActivityLogModule binds the @Optional() ActivityLogService the
    // registry service uses for its best-effort activity rows.
    imports: [DatabaseModule, AgentsModule, ActivityLogModule],
    providers: [RepoRegistryService],
    controllers: [RepoConnectionsController, AgentReposController],
    exports: [RepoRegistryService],
})
export class RepoConnectionsModule {}
