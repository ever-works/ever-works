import { Injectable, Logger } from '@nestjs/common';
import { EverConnectIntegrationService } from './ever-connect-integration.service';
import { EverConnectService } from './ever-connect.service';
import { PersonRequestsHandler } from './identity/person-requests.handler';
import { describeFailure, platformFailure } from './identity/platform-answer';

/** One event of the installation's feed. */
interface FeedEvent {
    readonly id: string;
    readonly type: string;
    readonly data: unknown;
}

/** The outcome of one read of the feed. */
export interface FeedPass {
    /** Events handled and acknowledged. */
    readonly handled: number;
    /** Whether Ever Platform has more events waiting. */
    readonly more: boolean;
}

/**
 * Reads the installation's event feed (`GET /v1/instances/me/events` after the
 * stored position), hands each event to its handler and acknowledges what was
 * handled (`POST /v1/instances/me/events/ack`), on the replica holding the
 * Ever Connect lease.
 *
 * - Consent events (`ever.consent.*`): the integration states are read again.
 * - `ever.registry.instance.approved`: the connection becomes active.
 * - `ever.registry.instance.disconnected|revoked`: the connection ends here too.
 * - `ever.registry.person.deletion_requested|export_requested`: answered by the
 *   person-request handler.
 *
 * A handler that fails stops the pass at that event: it and the events after it
 * are read again on the next pass. Other event types are acknowledged unread.
 */
@Injectable()
export class EverConnectFeedService {
    private readonly logger = new Logger(EverConnectFeedService.name);

    constructor(
        private readonly connection: EverConnectService,
        private readonly integrations: EverConnectIntegrationService,
        private readonly requests: PersonRequestsHandler,
    ) {}

    async pollOnce(waitS = 0): Promise<FeedPass> {
        const client = await this.connection.client();
        if (!client) return { handled: 0, more: false };
        const cursor = (await this.connection.connection()).lastFeedCursor;

        let page: { events: readonly FeedEvent[]; has_more: boolean; last_id: string };
        try {
            page = (await client.instances.events(cursor, { waitS })) as typeof page;
        } catch (error) {
            const failure = platformFailure(error);
            if (failure.kind === 'problem' && failure.status === 410) {
                // The position is past what Ever Platform keeps: read the state
                // again, then continue from where it says.
                await this.integrations.refresh();
                const lastId = (error as { lastId?: string }).lastId;
                if (lastId) {
                    await client.instances.ackEvents(lastId);
                    await this.connection.saveFeedCursor(lastId);
                    return { handled: 0, more: true };
                }
                // No position to continue from: wait for the next round rather
                // than asking again at once.
                this.logger.warn('Ever Platform asked for a resync without a position');
                return { handled: 0, more: false };
            }
            if (failure.kind === 'problem' && failure.code === 'credential_revoked') {
                await this.connection.ended('revoked');
                return { handled: 0, more: false };
            }
            throw error;
        }

        let handled = 0;
        let position = cursor;
        let stopped = false;
        for (const event of page.events) {
            try {
                const ended = await this.dispatch(event);
                handled += 1;
                position = event.id;
                if (ended) return { handled, more: false };
            } catch (error) {
                this.logger.warn(
                    `Ever Platform event ${event.type} not handled yet: ${describeFailure(platformFailure(error))}`,
                );
                stopped = true;
                break;
            }
        }
        // Every event of the page handled: continue after the page.
        if (!stopped && page.last_id) position = page.last_id;
        if (position && position !== cursor) {
            await client.instances.ackEvents(position);
            await this.connection.saveFeedCursor(position);
        }
        return { handled, more: !stopped && page.has_more };
    }

    /** Hand one event to its handler. `true` when the connection ended with it. */
    private async dispatch(event: FeedEvent): Promise<boolean> {
        if (this.requests.handles(event.type)) {
            await this.requests.handle(event);
            return false;
        }
        if (event.type.startsWith('ever.consent.')) {
            await this.integrations.refresh();
            return false;
        }
        switch (event.type) {
            case 'ever.registry.instance.approved':
                await this.connection.approved();
                await this.integrations.refresh();
                return false;
            case 'ever.registry.instance.disconnected':
                await this.connection.ended('disconnected');
                return true;
            case 'ever.registry.instance.revoked':
                await this.connection.ended('revoked');
                return true;
            default:
                return false;
        }
    }
}
