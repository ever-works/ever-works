import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull } from 'typeorm';
import { User } from '@ever-works/agent/entities';
import { WorkProposalsApiService } from './work-proposals.service';

/**
 * EW-584 Phase C — periodic re-run. Once per day, pick a small batch of
 * active users whose inferredInterests are stale (>30 days) and queue a
 * fresh research+proposals pipeline. Caps + opt-out are enforced inside
 * the API service, so this loop is intentionally simple.
 *
 * Disabled by default (USER_RESEARCH_SCHEDULED_RERUN_ENABLED=false) so
 * staging/preview environments don't burn quota.
 */
@Injectable()
export class ScheduledReRunService {
	private readonly logger = new Logger(ScheduledReRunService.name);

	constructor(
		@InjectRepository(User) private readonly users: Repository<User>,
		private readonly proposals: WorkProposalsApiService,
		private readonly config: ConfigService
	) {}

	@Cron(CronExpression.EVERY_DAY_AT_3AM)
	async runDaily(): Promise<void> {
		const enabled = this.config.get<string | boolean>(
			'USER_RESEARCH_SCHEDULED_RERUN_ENABLED',
			false
		);
		const isEnabled = typeof enabled === 'string' ? enabled === 'true' : !!enabled;
		if (!isEnabled) return;

		const batchSize = Number(
			this.config.get<string | number>('USER_RESEARCH_SCHEDULED_RERUN_BATCH', 20)
		);
		const staleAfterDays = Number(
			this.config.get<string | number>('USER_RESEARCH_SCHEDULED_RERUN_STALE_DAYS', 30)
		);

		const cutoff = new Date(Date.now() - staleAfterDays * 24 * 60 * 60 * 1000);

		try {
			// Pick users who are active, not opted out, and either have no profile
			// yet or whose profile is older than the cutoff. We can't compare a
			// JSON field's nested date directly in a portable way, so we widen
			// the candidate set and the limits service filters duplicates.
			const candidates = await this.users.find({
				where: [
					{ isActive: true, userResearchOptOut: false, inferredInterests: IsNull() },
					{ isActive: true, userResearchOptOut: false, updatedAt: LessThan(cutoff) }
				],
				take: batchSize,
				order: { updatedAt: 'ASC' }
			});

			this.logger.log(
				`Scheduled rerun: picked ${candidates.length} candidate user(s) (batchSize=${batchSize}, staleDays=${staleAfterDays})`
			);

			for (const user of candidates) {
				const profileResearchedAt = user.inferredInterests?.researchedAt
					? new Date(user.inferredInterests.researchedAt)
					: null;
				if (profileResearchedAt && profileResearchedAt > cutoff) continue;
				try {
					await this.proposals.refresh(user.id, 'scheduled');
				} catch (err) {
					this.logger.warn(
						`Scheduled rerun dispatch failed for ${user.id}: ${(err as Error).message}`
					);
				}
			}
		} catch (err) {
			this.logger.error(`Scheduled rerun failed: ${(err as Error).message}`);
		}
	}
}
