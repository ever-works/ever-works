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
}
