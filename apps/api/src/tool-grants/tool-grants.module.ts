import { Module } from '@nestjs/common';
import { PolicyModule } from '@ever-works/agent/policy';
import { AgentsModule } from '@ever-works/agent/agents';
import { DatabaseModule } from '@ever-works/agent/database';
import { WorkModule } from '@ever-works/agent/services';
import { FacadesModule } from '@ever-works/agent/facades';
import { ToolGrantsController } from './tool-grants.controller';
import { ToolGrantPresetsService } from './tool-grant-presets.service';

/**
 * Tool-grant matrix (audit item G4) — thin API module over the agent-side
 * `PolicyModule` (resolution, the narrowing rule and the single decision
 * point all live there).
 *
 * `WorkModule` supplies `WorkOwnershipService`, `AgentsModule` supplies
 * `AgentRepository`, and `DatabaseModule` supplies `OrganizationRepository`
 * + `UserRepository` — the four owner-scope checks the controller runs
 * BEFORE resolving or writing anything, so this endpoint can be neither a
 * cross-tenant policy oracle nor a way to write access policy into
 * somebody else's tenant.
 *
 * Mirrors `MergePolicyApiModule`. The one structural difference: tool
 * grants are their OWN rows, so unlike a merge policy they need a write
 * path here rather than riding along on an existing entity's PATCH.
 *
 * AW-15 adds `FacadesModule` (for `ConnectionScopesFacadeService` — which
 * access levels a provider plugin declares) and `ToolGrantPresetsService`,
 * which writes a chosen level onto this same lattice.
 */
@Module({
    imports: [PolicyModule, WorkModule, AgentsModule, DatabaseModule, FacadesModule],
    controllers: [ToolGrantsController],
    providers: [ToolGrantPresetsService],
    exports: [PolicyModule],
})
export class ToolGrantsApiModule {}
