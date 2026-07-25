import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { EventIngestModule } from '../ingest/ingest.module';
import { KnowledgeBaseModule } from '../services/knowledge-base.module';
import { PrReviewService } from './pr-review.service';

/**
 * GitHub PR review loop (Wave 7, features g+h) — agent-side module
 * owning the Work-aware reviewer (`PrReviewService`). No entity of its
 * own: reviews land through the Wave 6 event-ingest spine
 * (`github.pr.review` envelopes → Activity + Memory on the tick).
 *
 * Consumed by the API's `IngestModule` (webhook bridge → review
 * trigger) and available to chat via `buildPrReviewTools`
 * (`review_pull_request`). Webhook-driven end to end — no cron /
 * trigger-internal wiring needed.
 */
@Module({
    imports: [
        // WorkRepository — repo→Work matching + workId resolution.
        DatabaseModule,
        // Git / AI / agent-memory facades.
        FacadesModule,
        // EventIngestService — review envelopes into the spine.
        EventIngestModule,
        // KnowledgeBaseService — KB context bundle (best-effort).
        KnowledgeBaseModule,
    ],
    providers: [PrReviewService],
    exports: [PrReviewService],
})
export class PrReviewModule {}
