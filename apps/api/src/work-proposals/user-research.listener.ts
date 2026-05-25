import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkProposalSource, WorkProposalStatus } from '@ever-works/agent/user-research';
import { UserConfirmedEvent, UserCreatedEvent } from '../events';
import { WorkProposalsApiService } from './work-proposals.service';

@Injectable()
export class UserResearchListener {
    private readonly logger = new Logger(UserResearchListener.name);

    constructor(
        private readonly proposals: WorkProposalsApiService,
        private readonly config: ConfigService,
    ) {}

    @OnEvent(UserCreatedEvent.EVENT_NAME)
    async onUserCreated(event: UserCreatedEvent): Promise<void> {
        await this.dispatchSignupResearch(event.user.id);
    }

    @OnEvent(UserConfirmedEvent.EVENT_NAME)
    async onUserConfirmed(event: UserConfirmedEvent): Promise<void> {
        await this.dispatchSignupResearch(event.user.id);
    }

    private async dispatchSignupResearch(userId: string): Promise<void> {
        const enabled = this.config.get<string | boolean>('USER_RESEARCH_ENABLED', true);
        const isEnabled = typeof enabled === 'string' ? enabled !== 'false' : !!enabled;
        if (!isEnabled) {
            this.logger.debug('USER_RESEARCH_ENABLED is false; skipping research');
            return;
        }

        try {
            const existing = await this.proposals.list(userId, [
                WorkProposalStatus.PENDING,
                WorkProposalStatus.ACCEPTED,
                WorkProposalStatus.DISMISSED,
            ]);
            if (existing.length > 0) {
                this.logger.debug(
                    `Skipping auto-signup user research for ${userId}; proposals already exist`,
                );
                return;
            }

            const result = await this.proposals.refresh(userId, WorkProposalSource.AUTO_SIGNUP);
            this.logger.log(`User research dispatched for ${userId} (status=${result.status})`);
        } catch (err) {
            this.logger.warn(
                `Failed to dispatch user research for ${userId}: ${(err as Error).message}`,
            );
        }
    }
}
