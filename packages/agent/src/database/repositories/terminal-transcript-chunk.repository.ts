import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import {
    TerminalTranscriptChunk,
    TerminalTranscriptDirection,
} from '@src/entities/terminal-transcript-chunk.entity';

/** One append-ready chunk (already redacted by the service layer). */
export interface TerminalTranscriptChunkWrite {
    runId: string;
    seq: number;
    direction: TerminalTranscriptDirection;
    /** REDACTED text — the repository never scrubs; the service does. */
    text: string;
    byteLength: number;
}

/**
 * Terminal transcript chunks (streaming-terminal M9 / founder decision
 * D1). Append-only: there is no update path, and the only delete paths
 * are the retention sweeper and the run's own CASCADE.
 *
 * `appendMany` is idempotent by construction — `UNIQUE(runId, seq)` plus
 * `orIgnore()` (Postgres `ON CONFLICT DO NOTHING` / sqlite
 * `INSERT OR IGNORE`) means a re-published batch, a 413 split-and-retry,
 * or a duplicated relay publish writes the row exactly once and never
 * throws. That matters because the caller persists best-effort on the
 * live publish path: a transcript write must never fail a session.
 */
@Injectable()
export class TerminalTranscriptChunkRepository {
    constructor(
        @InjectRepository(TerminalTranscriptChunk)
        private readonly repository: Repository<TerminalTranscriptChunk>,
    ) {}

    /**
     * Insert a batch, ignoring rows whose (runId, seq) already exists.
     * Returns the number of rows offered (not the number actually
     * written — `orIgnore` does not report that portably).
     */
    async appendMany(chunks: ReadonlyArray<TerminalTranscriptChunkWrite>): Promise<number> {
        if (chunks.length === 0) {
            return 0;
        }
        await this.repository
            .createQueryBuilder()
            .insert()
            .into(TerminalTranscriptChunk)
            .values(
                chunks.map((chunk) => ({
                    runId: chunk.runId,
                    seq: chunk.seq,
                    direction: chunk.direction,
                    text: chunk.text,
                    byteLength: chunk.byteLength,
                })),
            )
            .orIgnore()
            .execute();
        return chunks.length;
    }

    /**
     * Replay page: chunks for a run with `seq >= fromSeq`, oldest first.
     * `limit` is clamped by the caller; ordering by `seq` (not
     * `createdAt`) keeps replay deterministic when a batch lands in one
     * transaction.
     */
    async listByRun(
        runId: string,
        fromSeq: number,
        limit: number,
    ): Promise<TerminalTranscriptChunk[]> {
        return this.repository
            .createQueryBuilder('chunk')
            .where('chunk.runId = :runId', { runId })
            .andWhere('chunk.seq >= :fromSeq', { fromSeq })
            .orderBy('chunk.seq', 'ASC')
            .take(limit)
            .getMany();
    }

    /** Total chunk count for a run (replay pagination metadata). */
    async countByRun(runId: string): Promise<number> {
        return this.repository.count({ where: { runId } });
    }

    /**
     * Distinct run ids with at least one chunk older than `cutoff`,
     * paged. The retention sweeper resolves each run's plan tier before
     * deciding whether that run's rows may actually be deleted, so this
     * is a candidate scan, never a delete list.
     */
    async findRunIdsWithChunksOlderThan(cutoff: Date, limit: number): Promise<string[]> {
        const rows = await this.repository
            .createQueryBuilder('chunk')
            .select('chunk.runId', 'runId')
            .where('chunk.createdAt < :cutoff', { cutoff })
            // Session-keyed chunks (FL-04, CONTRACTS R-9) carry no run: they
            // follow the session retention, never a run's plan tier.
            .andWhere('chunk.runId IS NOT NULL')
            .groupBy('chunk.runId')
            .orderBy('chunk.runId', 'ASC')
            .limit(limit)
            .getRawMany<{ runId: string }>();
        return rows.map((row) => row.runId);
    }

    /** Delete this run's chunks older than `cutoff`. Returns rows removed. */
    async deleteOlderThanForRun(runId: string, cutoff: Date): Promise<number> {
        const result = await this.repository.delete({ runId, createdAt: LessThan(cutoff) });
        return result.affected ?? 0;
    }

    /** Delete every chunk for these runs (retention window of 0 days). */
    async deleteForRuns(runIds: ReadonlyArray<string>): Promise<number> {
        if (runIds.length === 0) {
            return 0;
        }
        const result = await this.repository.delete({ runId: In([...runIds]) });
        return result.affected ?? 0;
    }

    // ─── Sessions on computers (FL-04 P3, CONTRACTS R-9) ───────────────────

    /**
     * Insert a batch of SESSION-keyed chunks (`runId` NULL), ignoring rows whose
     * `(fleetSessionId, seq)` already exists — the partial unique index
     * `uq_terminal_transcript_chunks_session_seq` — so a re-sent flush writes
     * once and never throws.
     */
    async appendSessionMany(chunks: ReadonlyArray<TerminalTranscriptSessionChunkWrite>): Promise<number> {
        if (chunks.length === 0) {
            return 0;
        }
        await this.repository
            .createQueryBuilder()
            .insert()
            .into(TerminalTranscriptChunk)
            .values(
                chunks.map((chunk) => ({
                    runId: null,
                    fleetSessionId: chunk.fleetSessionId,
                    seq: chunk.seq,
                    direction: chunk.direction,
                    text: chunk.text,
                    byteLength: chunk.byteLength,
                })),
            )
            .orIgnore()
            .execute();
        return chunks.length;
    }

    /** A session's chunks with `seq >= fromSeq`, oldest first. */
    async listBySession(
        fleetSessionId: string,
        fromSeq: number,
        limit: number,
    ): Promise<TerminalTranscriptChunk[]> {
        return this.repository
            .createQueryBuilder('chunk')
            .where('chunk.fleetSessionId = :fleetSessionId', { fleetSessionId })
            .andWhere('chunk.seq >= :fromSeq', { fromSeq })
            .orderBy('chunk.seq', 'ASC')
            .take(limit)
            .getMany();
    }

    /** How many chunks a session has, its highest `seq` and the first and last write. */
    async sessionStats(fleetSessionId: string): Promise<{
        count: number;
        maxSeq: number | null;
        firstAt: Date | null;
        lastAt: Date | null;
    }> {
        const row = await this.repository
            .createQueryBuilder('chunk')
            .select('COUNT(*)', 'count')
            .addSelect('MAX(chunk.seq)', 'maxSeq')
            .addSelect('MIN(chunk.createdAt)', 'firstAt')
            .addSelect('MAX(chunk.createdAt)', 'lastAt')
            .where('chunk.fleetSessionId = :fleetSessionId', { fleetSessionId })
            .getRawOne<{ count: string | number; maxSeq: string | number | null; firstAt: unknown; lastAt: unknown }>();
        const count = Number(row?.count ?? 0) || 0;
        const maxSeq = row?.maxSeq === null || row?.maxSeq === undefined ? null : Number(row.maxSeq);
        const toDate = (value: unknown): Date | null => {
            if (value === null || value === undefined) return null;
            const at = value instanceof Date ? value : new Date(String(value));
            return Number.isFinite(at.getTime()) ? at : null;
        };
        return {
            count,
            maxSeq: maxSeq !== null && Number.isFinite(maxSeq) ? maxSeq : null,
            firstAt: toDate(row?.firstAt),
            lastAt: toDate(row?.lastAt),
        };
    }

    /** Delete every session-keyed chunk older than `cutoff` (the fixed 14-day session retention). */
    async deleteSessionChunksOlderThan(cutoff: Date): Promise<number> {
        const result = await this.repository
            .createQueryBuilder()
            .delete()
            .from(TerminalTranscriptChunk)
            .where('"fleetSessionId" IS NOT NULL')
            .andWhere('"createdAt" < :cutoff', { cutoff })
            .execute();
        return result.affected ?? 0;
    }
}

/** One append-ready SESSION chunk (already redacted by the service layer). */
export interface TerminalTranscriptSessionChunkWrite {
    fleetSessionId: string;
    seq: number;
    direction: TerminalTranscriptDirection;
    /** REDACTED text. */
    text: string;
    byteLength: number;
}
