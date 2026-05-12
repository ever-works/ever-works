import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { UserConfirmedEvent } from '../events';
import { WorkProposalsApiService } from './work-proposals.service';

/**
 * EW-584 — fires on user signup (OAuth or email-verified). Kicks off the
 * background research+proposals pipeline. Opt-out flag on User (default off)
 * is checked inside UserResearchService; we still respect the global env flag
 * USER_RESEARCH_ENABLED (default true) for kill-switching the feature in prod.
 *
 * Signup is NEVER blocked: the listener runs async and any error is logged.
 */
@Injectable()
export class UserResearchListener {
	private readonly logger = new Logger(UserResearchListener.name);

	constructor(
		private readonly proposals: WorkProposalsApiService,
		private readonly config: ConfigService
	) {}

	@OnEvent(UserConfirmedEvent.EVENT_NAME)
	async onUserConfirmed(event: UserConfirmedEvent): Promise<void> {
		const enabled = this.config.get<string | boolean>('USER_RESEARCH_ENABLED', true);
		const isEnabled = typeof enabled === 'string' ? enabled !== 'false' : !!enabled;
		if (!isEnabled) {
			this.logger.debug('USER_RESEARCH_ENABLED is false; skipping research');
			return;
		}

		try {
			const result = await this.proposals.refresh(event.user.id, 'auto-signup');
			this.logger.log(
				`User research dispatched for ${event.user.id} (status=${result.status})`
			);
		} catch (err) {
			this.logger.warn(
				`Failed to dispatch user research for ${event.user.id}: ${(err as Error).message}`
			);
		}
	}
}
