import {
    Body,
    Controller,
    ForbiddenException,
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
import { AgentRunRepository } from '@ever-works/agent/database';
import { Public } from '../auth';
import { TerminalAttachService } from './terminal-attach.service';
import { TerminalRelayRegistry } from './terminal-relay.registry';

const TERMINAL_STATES = new Set(['starting', 'attached', 'ended']);
const TERMINAL_END_REASONS = new Set(['completed', 'crashed', 'closed', 'parked']);

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
        private readonly runs: AgentRunRepository,
    ) {}

    private ensureSecret(authorization?: string, triggerSecret?: string) {
        const expectedSecret = config.trigger.getInternalSecret();
        if (!expectedSecret) {
            throw new ForbiddenException('Terminal internal secret is not configured');
        }
        // Two accepted carriers: the house `x-trigger-secret` header (what
        // TriggerInternalApiClient already sends) and Authorization: Bearer.
        const provided =
            typeof triggerSecret === 'string' && triggerSecret.length > 0
                ? triggerSecret
                : typeof authorization === 'string' && authorization.startsWith('Bearer ')
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
        @Headers('x-trigger-secret') triggerSecret: string | undefined,
        @Param('runId') runId: string,
        @Body() body: unknown,
    ): { accepted: number; dropped: number } {
        this.ensureSecret(authorization, triggerSecret);
        if (!isValidTerminalRunId(runId)) {
            throw new ForbiddenException('Invalid run id');
        }
        const items = Array.isArray(body) ? body : [body];
        let accepted = 0;
        let dropped = 0;
        for (const item of items.slice(0, 2048)) {
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
        @Headers('x-trigger-secret') triggerSecret: string | undefined,
        @Param('runId') runId: string,
    ): { token: string; wsPath: string; expiresInSec: number } {
        this.ensureSecret(authorization, triggerSecret);
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

    /**
     * Heartbeat + terminal-lifecycle updates from the session host (M6).
     * Enum-whitelisted fields only — a compromised worker payload can
     * touch nothing but the terminal columns, and even those only with
     * known values. `lastHeartbeatAt` is server-stamped, never trusted
     * from the body.
     */
    @Public()
    @Post(':runId/heartbeat')
    @HttpCode(HttpStatus.OK)
    async heartbeat(
        @Headers('authorization') authorization: string | undefined,
        @Headers('x-trigger-secret') triggerSecret: string | undefined,
        @Param('runId') runId: string,
        @Body()
        body: {
            state?: string;
            endedReason?: string;
            providerId?: string;
            cliSessionId?: string;
            lastFrameSeq?: number;
            persistent?: boolean;
        },
    ): Promise<{ ok: boolean }> {
        this.ensureSecret(authorization, triggerSecret);
        if (!isValidTerminalRunId(runId)) {
            throw new ForbiddenException('Invalid run id');
        }
        const patch: Parameters<AgentRunRepository['updateTerminalColumns']>[1] = {
            lastHeartbeatAt: new Date(),
        };
        if (typeof body?.state === 'string' && TERMINAL_STATES.has(body.state)) {
            patch.terminalState = body.state;
        }
        if (typeof body?.endedReason === 'string' && TERMINAL_END_REASONS.has(body.endedReason)) {
            patch.terminalEndedReason = body.endedReason;
        }
        if (typeof body?.providerId === 'string' && body.providerId.length <= 64) {
            patch.terminalProviderId = body.providerId;
        }
        if (typeof body?.cliSessionId === 'string' && body.cliSessionId.length <= 128) {
            patch.cliSessionId = body.cliSessionId;
        }
        if (Number.isSafeInteger(body?.lastFrameSeq) && (body.lastFrameSeq as number) >= 0) {
            patch.lastFrameSeq = body.lastFrameSeq as number;
        }
        if (typeof body?.persistent === 'boolean') {
            patch.persistent = body.persistent;
        }
        await this.runs.updateTerminalColumns(runId, patch);
        return { ok: true };
    }
}
