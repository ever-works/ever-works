import {
    Body,
    Controller,
    ForbiddenException,
    PayloadTooLargeException,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { config } from '@ever-works/agent/config';
import { normalizeTerminalFrame, isValidTerminalRunId } from '@ever-works/contracts';
import { Public } from '../auth';
import { TerminalAttachService } from './terminal-attach.service';
import { TerminalRelayRegistry } from './terminal-relay.registry';

/**
 * Worker-side internal endpoints (streaming-terminal M3):
 *
 *   POST /api/internal/terminal/:runId/frames        — batch publish
 *   POST /api/internal/terminal/:runId/worker-token  — worker attach token
 *
 * Auth: `Authorization: Bearer <TRIGGER_INTERNAL_SECRET>` — the exact
 * `ensureSecret` posture of `TriggerInternalController` (constant-time
 * incl. fixed-cost length mismatch; **fail-closed** when unconfigured:
 * a relay with no secret must refuse every publish, never accept all).
 *
 * Frames are re-validated per element via `normalizeTerminalFrame`
 * (null-never-throw); invalid elements are dropped and counted, valid
 * ones publish. The registry's own direction guard refuses any
 * client-direction kind that survives — output can only originate here.
 *
 * Batch size rides the global JSON body limit (M-19, ~1MB); the worker
 * session host flushes small frequent batches, so a single batch never
 * approaches one max-size frame. Oversize → express 413, worker retries
 * with a split batch (session-host milestone).
 */
@ApiExcludeController()
@SkipThrottle({ short: true, medium: true, long: true })
@Controller('api/internal/terminal')
export class TerminalInternalController {
    constructor(
        private readonly registry: TerminalRelayRegistry,
        private readonly attach: TerminalAttachService,
    ) {}

    private ensureSecret(authorization?: string) {
        const expectedSecret = config.trigger.getInternalSecret();
        if (!expectedSecret) {
            throw new ForbiddenException('Terminal internal secret is not configured');
        }
        const provided =
            typeof authorization === 'string' && authorization.startsWith('Bearer ')
                ? authorization.slice('Bearer '.length)
                : '';
        if (provided.length === 0) {
            throw new ForbiddenException('Invalid terminal internal secret');
        }
        const expectedBuf = Buffer.from(expectedSecret, 'utf8');
        const providedBuf = Buffer.from(provided, 'utf8');
        const lengthsMatch = expectedBuf.length === providedBuf.length;
        const comparisonBuf = lengthsMatch ? providedBuf : Buffer.alloc(expectedBuf.length);
        const bytesMatch = timingSafeEqual(expectedBuf, comparisonBuf);
        if (!lengthsMatch || !bytesMatch) {
            throw new ForbiddenException('Invalid terminal internal secret');
        }
    }

    @Public()
    @Post(':runId/frames')
    @HttpCode(HttpStatus.ACCEPTED)
    publishFrames(
        @Headers('authorization') authorization: string | undefined,
        @Param('runId') runId: string,
        @Body() body: unknown,
    ): { accepted: number; dropped: number } {
        this.ensureSecret(authorization);
        if (!isValidTerminalRunId(runId)) {
            throw new ForbiddenException('Invalid run id');
        }
        const items = Array.isArray(body) ? body : [body];
        if (items.length > 2048) {
            // The worker transport splits batches on 413 — never silently
            // discard the tail of an oversized batch.
            throw new PayloadTooLargeException('Frame batch exceeds 2048 items');
        }
        let accepted = 0;
        let dropped = 0;
        for (const item of items) {
            const frame = normalizeTerminalFrame(item);
            if (frame && this.registry.publish(runId, frame)) {
                accepted++;
            } else {
                dropped++;
            }
        }
        return { accepted, dropped };
    }

    /**
     * Worker-scoped attach token, brokered by run id — credentials are
     * requested job-side and never ride the task payload (the worker
     * uses this token on the SAME WebSocket gateway as browsers, with
     * `role: 'worker'`).
     */
    @Public()
    @Post(':runId/worker-token')
    @HttpCode(HttpStatus.CREATED)
    mintWorkerToken(
        @Headers('authorization') authorization: string | undefined,
        @Param('runId') runId: string,
    ): { token: string; wsPath: string; expiresInSec: number } {
        this.ensureSecret(authorization);
        if (!isValidTerminalRunId(runId)) {
            throw new ForbiddenException('Invalid run id');
        }
        const { token, expiresInSec } = this.attach.mint({
            userId: 'worker',
            runId,
            role: 'worker',
        });
        return { token, wsPath: `/ws/terminal/${runId}`, expiresInSec };
    }
}
