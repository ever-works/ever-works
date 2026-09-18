import { Module, type Type } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '../../auth/auth.module';
import { GitProviderController } from './git-provider.controller';
import { GitProviderService } from './git-provider.service';
import {
    E2eGitHubConnectionSeedController,
    isE2eGitHubConnectionSeedEnabled,
} from './e2e-github-connection-seed.controller';

/**
 * The controllers this module declares, in order: the git-provider read surface
 * (`GitProviderController`) and — **only when the gate is open at boot** —
 * T63's non-production connection-seeding route
 * (`POST /api/e2e/github-connection/seed`, plan §8.8 surface (b)).
 *
 * Why conditional registration rather than a guard alone: a production process
 * then has no such path in its router at all, which is a stronger statement
 * than "the handler refuses" — the route is not merely closed, it was never
 * mounted. The guard on the controller
 * (`e2e-github-connection-seed.controller.ts` → `E2eConnectionSeedEnabledGuard`)
 * is the other half: it re-reads the gate on every request, so arming or
 * disarming `EVER_WORKS_E2E_FAKES` in a running non-production process opens
 * and closes the door without a restart, and a process that booted outside
 * production cannot serve the route once it is pointed at production traffic.
 *
 * `isE2eGitHubConnectionSeedEnabled()` is production-first, so `NODE_ENV=production`
 * can never take the first branch — and an unarmed switch, or an unset fake
 * origin, takes the second, in every environment. This is the same posture as
 * `AppLauncherModule`'s registration of APW-11 T33's seed route
 * (`apps/api/src/app-launcher/app-launcher.module.ts:69-72`), which is the
 * programme's precedent for a non-production lane hook (CONTRACTS R-40).
 *
 * The read controller's position is unchanged and nothing is removed: this is
 * one appended entry behind one condition.
 */
const CONTROLLERS: Type<unknown>[] = [GitProviderController];
if (isE2eGitHubConnectionSeedEnabled()) {
    CONTROLLERS.push(E2eGitHubConnectionSeedController);
}

@Module({
    imports: [FacadesModule, DatabaseModule, AuthModule],
    controllers: CONTROLLERS,
    providers: [GitProviderService],
    exports: [GitProviderService],
})
export class GitProviderModule {}
