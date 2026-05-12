import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkCreatedEvent } from '@ever-works/agent/events';
import { WorkProposalsApiService } from './work-proposals.service';

@Injectable()
export class WorkCreatedLearningListener {
    private readonly logger = new Logger(WorkCreatedLearningListener.name);

    constructor(private readonly proposals: WorkProposalsApiService) {}

    @OnEvent(WorkCreatedEvent.EVENT_NAME)
    async onWorkCreated(event: WorkCreatedEvent): Promise<void> {
        const userId = (event as { work: { userId?: string } }).work?.userId;
        if (!userId) {
            this.logger.debug('WorkCreatedEvent missing userId; skipping learning ingest');
            return;
        }
        // Categories / tags arrays may live in different shapes across versions;
        // best-effort pluck. The service handles missing data gracefully.
        const work = event.work as unknown as {
            userId?: string;
            name?: string;
            categories?: Array<{ name?: string }> | string[];
            tags?: Array<{ name?: string }> | string[];
        };
        const categories =
            Array.isArray(work.categories) && work.categories.length > 0
                ? (work.categories as Array<{ name?: string } | string>)
                      .map((c) => (typeof c === 'string' ? c : c?.name))
                      .filter((s): s is string => !!s)
                : undefined;
        const tags =
            Array.isArray(work.tags) && work.tags.length > 0
                ? (work.tags as Array<{ name?: string } | string>)
                      .map((t) => (typeof t === 'string' ? t : t?.name))
                      .filter((s): s is string => !!s)
                : undefined;
        await this.proposals.ingestWorkCreated(userId, { categories, tags, name: work.name });
    }
}
