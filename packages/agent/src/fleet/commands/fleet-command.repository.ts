import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { FLEET_COMMAND_RECENT, type FleetCommandRequester } from '@ever-works/contracts';
import { FleetCommand } from '../../entities/fleet-command.entity';
import { FleetCommandRun } from '../../entities/fleet-command-run.entity';

/**
 * Data access for `fleet_commands` and `fleet_command_runs` (FL-12). Every
 * transition of a run out of `running` is a conditional UPDATE that restates
 * "still running", so the node's end, a link loss and the stale sweep can
 * never both win: an ended run stays ended with the first end written.
 */
@Injectable()
export class FleetCommandRepository {
    constructor(
        @InjectRepository(FleetCommand)
        private readonly commands: Repository<FleetCommand>,
        @InjectRepository(FleetCommandRun)
        private readonly runs: Repository<FleetCommandRun>,
    ) {}

    async createCommand(data: Partial<FleetCommand>): Promise<FleetCommand> {
        return this.commands.save(this.commands.create(data));
    }

    async createRuns(data: Array<Partial<FleetCommandRun>>): Promise<FleetCommandRun[]> {
        if (data.length === 0) return [];
        return this.runs.save(data.map((row) => this.runs.create(row)));
    }

    async findCommand(id: string): Promise<FleetCommand | null> {
        return this.commands.findOne({ where: { id } });
    }

    /**
     * A person's most recent one-off Commands (Recent, spec FR-17); with
     * `requestedBy`, only those a person (`user`) or an Agent (`agent`) asked
     * for (the Agent tools read the latter, FL-12 P2).
     */
    async listRecentForUser(
        userId: string,
        limit: number = FLEET_COMMAND_RECENT,
        options: { requestedBy?: FleetCommandRequester } = {},
    ): Promise<FleetCommand[]> {
        return this.commands.find({
            where: {
                userId,
                cadence: IsNull(),
                ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
            },
            order: { createdAt: 'DESC' },
            take: Math.min(50, Math.max(1, Math.floor(limit))),
        });
    }

    /** A person's one-off Commands still running (the eight-at-once limit). */
    async countRunningForUser(userId: string): Promise<number> {
        return this.commands.count({ where: { userId, state: 'running', cadence: IsNull() } });
    }

    async findRuns(commandId: string): Promise<FleetCommandRun[]> {
        return this.runs.find({ where: { commandId }, order: { createdAt: 'ASC' } });
    }

    async findRunsFor(commandIds: readonly string[]): Promise<FleetCommandRun[]> {
        if (commandIds.length === 0) return [];
        return this.runs.find({
            where: { commandId: In([...commandIds]) },
            order: { createdAt: 'ASC' },
        });
    }

    async findRun(id: string): Promise<FleetCommandRun | null> {
        return this.runs.findOne({ where: { id } });
    }

    /** The latest run on a computer (the computer page's "Last command", P2). */
    async findLatestRunForNode(nodeId: string): Promise<FleetCommandRun | null> {
        return this.runs.findOne({ where: { nodeId }, order: { startedAt: 'DESC' } });
    }

    /** Write live output facts while the run is still running (a flush); false once it ended. */
    async updateRunIfRunning(id: string, patch: Partial<FleetCommandRun>): Promise<boolean> {
        const result = await this.runs.update({ id, status: 'running' }, patch);
        return (result.affected ?? 0) > 0;
    }

    async updateCommand(id: string, patch: Partial<FleetCommand>): Promise<void> {
        await this.commands.update({ id }, patch);
    }

    /**
     * Retention (FL-12 P3, T-27): NULL the stored head and tail of up to
     * `batchSize` ended runs whose end is older than `cutoff`, keeping the
     * rows (status, exit code, timings, the refusal). Answers how many it
     * cleared; a run still running is never touched.
     */
    async purgeEndedOutputs(cutoff: Date, batchSize: number): Promise<number> {
        const rows = await this.runs.find({
            select: { id: true },
            where: [
                { status: Not('running'), endedAt: LessThan(cutoff), outputHead: Not(IsNull()) },
                { status: Not('running'), endedAt: LessThan(cutoff), outputTail: Not(IsNull()) },
            ],
            order: { endedAt: 'ASC' },
            take: Math.max(1, Math.floor(batchSize)),
        });
        if (rows.length === 0) return 0;
        await this.runs.update(
            { id: In(rows.map((row) => row.id)) },
            { outputHead: null, outputTail: null },
        );
        return rows.length;
    }
}
