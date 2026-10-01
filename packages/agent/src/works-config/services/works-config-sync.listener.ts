import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
// Concrete file, NOT the `@src/events` barrel.
//
// `@src/...` is ambiguous across the monorepo: `apps/api/src/events/` and
// `packages/agent/src/events/` both exist, and `apps/api`'s jest maps
// `^@src/(.*)$` to an ARRAY that prefers the api's own `src` first
// (`apps/api/jest.config.js` — see its own comment on this hazard). So under an
// api spec this barrel resolved to the API's events index, which does not export
// `WorksConfigSyncRequestedEvent`, and the `@OnEvent` decorator below evaluated
// `undefined.EVENT_NAME` at IMPORT time — taking the whole suite down before a
// test ran, not just this listener.
//
// Measured in CI run 35591005499 and reproduced locally: the chain is
// `apps/api/src/trigger/trigger-internal.module.ts:28` -> `AppWorksModule` ->
// `@ever-works/agent/works-config` (this barrel) -> this file. The deep path
// below has no such ambiguity: `apps/api/src/events/works-config-sync-requested.event`
// does not exist, so the array mapper falls through to the agent's copy.
import { WorksConfigSyncRequestedEvent } from '@src/events/works-config-sync-requested.event';
import { WorksConfigRepositorySyncService } from './works-config-repository-sync.service';

@Injectable()
export class WorksConfigSyncListener {
    constructor(private readonly syncService: WorksConfigRepositorySyncService) {}

    @OnEvent(WorksConfigSyncRequestedEvent.EVENT_NAME, { async: true })
    async handleSyncRequested(event: WorksConfigSyncRequestedEvent): Promise<void> {
        await this.syncService.syncWork({
            workId: event.workId,
            userId: event.userId,
            reason: event.reason,
        });
    }
}
