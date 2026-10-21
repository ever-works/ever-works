import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { FLEET_COMMAND_RECENT } from '@ever-works/contracts';
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

    /** A person's most recent one-off Commands (Recent, spec FR-17). */
    async listRecentForUser(userId: string, limit: number = FLEET_COMMAND_RECENT): Promise<FleetCommand[]> {
        return this.commands.find({
            where: { userId, cadence: IsNull() },
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
}
