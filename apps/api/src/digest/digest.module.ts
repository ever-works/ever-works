import { Module } from '@nestjs/common';
import { DigestModule } from '@ever-works/agent/digest';
import { FacadesModule } from '@ever-works/agent/facades';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DigestController } from './digest.controller';

/**
 * Digest API module — the scoped READ over the agent-side
 * `DigestModule` (composition, windowing and rendering all live there)
 * plus the settings read/write for both scopes.
 *
 * Named `DigestApiModule` to avoid colliding with the agent-side
 * `DigestModule` it wraps, matching `MergePolicyApiModule` /
 * `MeetingsApiModule` / `FleetApiModule` next door.
 *
 * `OrganizationsModule` supplies the shared
 * `OrganizationMembershipService` so every organization-scoped read and
 * write is authorized by the ONE audited tenant-ownership check rather
 * than a local copy. `FacadesModule` supplies `AiFacadeService`, used
 * only to report whether a narrative is possible at all.
 *
 * `ScopeContextService` is `@Global()` and needs no import.
 */
@Module({
    imports: [DigestModule, OrganizationsModule, FacadesModule],
    controllers: [DigestController],
    exports: [DigestModule],
})
export class DigestApiModule {}
