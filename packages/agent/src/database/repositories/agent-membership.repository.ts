import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
	AgentMembership,
	AgentMembershipTargetType,
} from '../../entities/agent-membership.entity';

@Injectable()
export class AgentMembershipRepository {
	constructor(
		@InjectRepository(AgentMembership)
		private readonly repository: Repository<AgentMembership>,
	) {}

	async findByAgent(agentId: string): Promise<AgentMembership[]> {
		return this.repository.find({ where: { agentId } });
	}

	/**
	 * "Which Agents reach this Mission/Idea/Work?" — used by the
	 * per-target tabs (`/missions/:id/agents` etc.) to surface
	 * tenant-scoped Agents whose `targets` include this id.
	 */
	async findAgentIdsForTarget(
		targetType: AgentMembershipTargetType,
		targetId: string | null,
	): Promise<string[]> {
		const rows = await this.repository.find({
			where: {
				targetType,
				targetId: targetId ?? IsNull(),
			},
			select: ['agentId'],
		});
		return rows.map((r) => r.agentId);
	}

	async addMembership(
		agentId: string,
		targetType: AgentMembershipTargetType,
		targetId: string | null,
	): Promise<AgentMembership> {
		// Idempotent insert — UNIQUE(agentId, targetType, targetId).
		const existing = await this.repository.findOne({
			where: { agentId, targetType, targetId: targetId ?? IsNull() },
		});
		if (existing) {
			return existing;
		}
		const row = this.repository.create({ agentId, targetType, targetId });
		return this.repository.save(row);
	}

	async removeMembership(
		agentId: string,
		targetType: AgentMembershipTargetType,
		targetId: string | null,
	): Promise<void> {
		await this.repository.delete({
			agentId,
			targetType,
			targetId: targetId ?? IsNull(),
		});
	}

	/**
	 * Replace the full membership set for an Agent in one call (used by
	 * `AgentService.update` when the `targets` JSON is rewritten).
	 */
	async replaceForAgent(
		agentId: string,
		memberships: Array<{ targetType: AgentMembershipTargetType; targetId: string | null }>,
	): Promise<void> {
		await this.repository.delete({ agentId });
		if (memberships.length === 0) {
			return;
		}
		const rows = this.repository.create(
			memberships.map((m) => ({
				agentId,
				targetType: m.targetType,
				targetId: m.targetId,
			})),
		);
		await this.repository.save(rows);
	}

	async deleteByAgentId(agentId: string): Promise<void> {
		await this.repository.delete({ agentId });
	}

	async findAgentIdsForAnyTarget(
		targetType: AgentMembershipTargetType,
		targetIds: string[],
	): Promise<Map<string, string[]>> {
		if (targetIds.length === 0) {
			return new Map();
		}
		const rows = await this.repository.find({
			where: { targetType, targetId: In(targetIds) },
		});
		const out = new Map<string, string[]>();
		for (const r of rows) {
			if (!r.targetId) continue;
			const list = out.get(r.targetId) ?? [];
			list.push(r.agentId);
			out.set(r.targetId, list);
		}
		return out;
	}
}
