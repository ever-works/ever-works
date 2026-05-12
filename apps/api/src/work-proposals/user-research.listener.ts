import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkProposalSource } from '@ever-works/agent/user-research';
import { UserConfirmedEvent } from '../events';
import { WorkProposalsApiService } from './work-proposals.service';

@Injectable()
export class UserResearchListener {
    private readonly logger = new Logger(UserResearchListener.name);

    constructor(
        private readonly proposals: WorkProposalsApiService,
        private readonly config: ConfigService,
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
            const result = await this.proposals.refresh(
                event.user.id,
                WorkProposalSource.AUTO_SIGNUP,
            );
            this.logger.log(
                `User research dispatched for ${event.user.id} (status=${result.status})`,
            );
        } catch (err) {
            this.logger.warn(
                `Failed to dispatch user research for ${event.user.id}: ${(err as Error).message}`,
            );
        }
    }
}
