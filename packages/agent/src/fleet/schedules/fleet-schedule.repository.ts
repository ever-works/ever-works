import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { FLEET_SCHEDULE_HISTORY } from '@ever-works/contracts';
import { FleetCommand } from '../../entities/fleet-command.entity';
import { FleetCommandRun } from '../../entities/fleet-command-run.entity';

/**
 * Schedules on computers (FL-13) — data access for Command schedules: the
 * `fleet_commands` rows that carry a `cadence` (R-2) and their runs in
 * `fleet_command_runs`. FL-12's `FleetCommandRepository` keeps the one-off
 * Commands (it filters `cadence IS NULL`); this one only ever reads and
 * writes rows with a cadence, so the two never touch each other's rows.
 *
 * A schedule's ONE computer is `nodeIds[0]` (`simple-json` text). "The
 * schedules on this computer" is a `LIKE '%"<uuid>"%'` on that text — the
 * id is a validated uuid, so it carries no wildcard — which reads the same
 * on Postgres and on the better-sqlite3 CI stack.
 */
@Injectable()
export class FleetScheduleRepository {
    constructor(
        @InjectRepository(FleetCommand)
        private readonly commands: Repository<FleetCommand>,
        @InjectRepository(FleetCommandRun)
        private readonly runs: Repository<FleetCommandRun>,
    ) {}

    async create(data: Partial<FleetCommand>): Promise<FleetCommand> {
        return this.commands.save(this.commands.create(data));
    }

    /** One schedule (deleted ones included — the history outlives the delete), or null. */
    async find(id: string): Promise<FleetCommand | null> {
        return this.commands.findOne({ where: { id, cadence: Not(IsNull()) } });
    }

    /** A person's schedules; deleted ones only when `includeDeletedSince` names how far back. */
    async listForUser(userId: string, includeDeletedSince: Date | null = null): Promise<FleetCommand[]> {
        const where = includeDeletedSince
            ? [
                  { userId, cadence: Not(IsNull()), deletedAt: IsNull() },
                  { userId, cadence: Not(IsNull()), deletedAt: Not(IsNull()) },
              ]
            : [{ userId, cadence: Not(IsNull()), deletedAt: IsNull() }];
        const rows = await this.commands.find({ where, order: { createdAt: 'ASC' } });
        if (!includeDeletedSince) return rows;
        const cutoff = includeDeletedSince.getTime();
        return rows.filter((row) => !row.deletedAt || toMs(row.deletedAt) >= cutoff);
    }

    /** Every schedule on one computer (any person's), deleted ones too when asked. */
    async listForNode(nodeId: string, options: { includeDeleted?: boolean } = {}): Promise<FleetCommand[]> {
        const query = this.commands
            .createQueryBuilder('command')
            .where('command.cadence IS NOT NULL')
            .andWhere('command.nodeIds LIKE :pattern', { pattern: `%"${nodeId.toLowerCase()}"%` })
            .orderBy('command.createdAt', 'ASC');
        if (!options.includeDeleted) query.andWhere('command.deletedAt IS NULL');
        const rows = await query.getMany();
        // The LIKE is a prefilter; the list is the truth.
        return rows.filter((row) => (row.nodeIds ?? [])[0]?.toLowerCase() === nodeId.toLowerCase());
    }

    /** Live (not deleted) schedules on one computer — what the 50-per-computer limit counts. */
    async countLiveForNode(nodeId: string): Promise<number> {
        return (await this.listForNode(nodeId)).length;
    }

    /** The computers that hold at least one live schedule (the reconcile pass walks them). */
    async listScheduledNodeIds(limit = 1_000): Promise<string[]> {
        const rows = await this.commands.find({
            select: { id: true, nodeIds: true },
            where: { cadence: Not(IsNull()), deletedAt: IsNull() },
            take: Math.max(1, limit * 10),
        });
        const ids = new Set<string>();
        for (const row of rows) {
            const nodeId = (row.nodeIds ?? [])[0];
            if (typeof nodeId === 'string' && nodeId.length > 0) ids.add(nodeId.toLowerCase());
            if (ids.size >= limit) break;
        }
        return [...ids];
    }

    async update(id: string, patch: Partial<FleetCommand>): Promise<void> {
        await this.commands.update({ id }, patch);
    }

    /** The machine applied `generation`: every row of that set (generation ≤ it) is synced. */
    async markSynced(ids: readonly string[], generation: number): Promise<void> {
        if (ids.length === 0) return;
        await this.commands.update(
            { id: In([...ids]), syncGeneration: LessThanOrEqual(generation) },
            { syncedGeneration: generation },
        );
    }

    /** One schedule's newest runs, newest first (the history, FR-20: 30). */
    async findRuns(commandId: string, limit: number = FLEET_SCHEDULE_HISTORY): Promise<FleetCommandRun[]> {
        return this.runs.find({
            where: { commandId },
            order: { startedAt: 'DESC' },
            take: Math.min(200, Math.max(1, Math.floor(limit))),
        });
    }

    /** The newest `perSchedule` runs of each schedule, newest first per schedule. */
    async findRecentRunsFor(
        commandIds: readonly string[],
        perSchedule = 6,
    ): Promise<Map<string, FleetCommandRun[]>> {
        const out = new Map<string, FleetCommandRun[]>();
        if (commandIds.length === 0) return out;
        const rows = await this.runs.find({
            where: { commandId: In([...commandIds]) },
            order: { startedAt: 'DESC' },
            take: Math.min(5_000, commandIds.length * Math.max(perSchedule, 1) * 4),
        });
        for (const row of rows) {
            const list = out.get(row.commandId) ?? [];
            if (list.length < perSchedule) list.push(row);
            out.set(row.commandId, list);
        }
        return out;
    }

    async countRuns(commandId: string): Promise<number> {
        return this.runs.count({ where: { commandId } });
    }

    async findRun(id: string): Promise<FleetCommandRun | null> {
        return this.runs.findOne({ where: { id } });
    }

    /** Insert or replace one run by its id (the machine's run id — reconciling twice is one row). */
    async saveRun(row: Partial<FleetCommandRun> & { id: string }): Promise<FleetCommandRun> {
        return this.runs.save(this.runs.create(row));
    }

    /** The latest end the platform holds for this computer's schedule runs (the `since` watermark). */
    async latestEndedAtForNode(nodeId: string, commandIds: readonly string[]): Promise<Date | null> {
        if (commandIds.length === 0) return null;
        const row = await this.runs.findOne({
            where: { nodeId, commandId: In([...commandIds]), endedAt: Not(IsNull()) },
            order: { endedAt: 'DESC' },
        });
        return row?.endedAt ? new Date(toMs(row.endedAt)) : null;
    }
}

function toMs(value: Date | string): number {
    return value instanceof Date ? value.getTime() : Date.parse(String(value));
}
