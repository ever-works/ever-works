import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    FLEET_SESSION_NOTIFY_DEDUPE_MS,
    isFleetSessionDecisionReason,
    type FleetSessionAttention,
} from '@ever-works/contracts';
import { AgentRepository } from '../../database/repositories/agent.repository';
import type { FleetSession } from '../../entities/fleet-session.entity';
import { INBOX_PRODUCER, type InboxProducer } from '../../inbox/inbox-producer.port';
import { NotificationService } from '../../notifications/notification.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import type {
    FleetSessionAttentionAnswer,
    FleetSessionAttentionSink,
} from './fleet-session-attention.port';

/** Display names of the CLIs, as the Inbox provenance line reads them (spec §5.8). */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    shell: 'Shell',
};

/**
 * Session attention (FL-05 P2, CONTRACTS R-12, §5.2, spec FR-24 … FR-27a,
 * FR-37 … FR-40) — where an attention edge goes once the row holds it. One
 * key, every door:
 *
 *  - `question` / `permission` → ONE Inbox item of kind `question` /
 *    `approval` that IS the Decision in My Decisions (options as the CLI
 *    showed them, the first one recommended), and the "needs you"
 *    notification;
 *  - `blocked` / `failed` → an Inbox notice, and the needs-you / failed
 *    notification;
 *  - `finished` → the "finished" notification only (unread lives on the row),
 *    and only when the node said the turn's end is news (not a boundary).
 *
 * Cleared (answered anywhere, the terminal included, or the session ended):
 * the Inbox item closes — answered with the option id, or archived when the
 * session ended (a Decision expires with its session and is never answered
 * automatically) — and the needs-you notification is dismissed.
 *
 * Notifications for one subject (session + needs-you / finished / failed)
 * go out at most once per {@link FLEET_SESSION_NOTIFY_DEDUPE_MS} (FR-39, U13),
 * on top of the per-key deduplication of the notification rows. A shell
 * never notifies (FR-40); interrupted and cancelled sessions never raise an
 * attention to notify about (the node and the end path see to that).
 * Best-effort by contract: a failure here is logged and never fails the
 * report that raised it.
 */
@Injectable()
export class FleetSessionAttentionDelivery implements FleetSessionAttentionSink {
    private readonly logger = new Logger(FleetSessionAttentionDelivery.name);
    /** `sessionId:subject` → when its last notification went out. */
    private readonly lastSent = new Map<string, number>();
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly nodes: FleetNodeRepository,
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
        @Optional() private readonly notifications?: NotificationService,
        @Optional() private readonly agents?: AgentRepository,
    ) {}

    async attentionRaised(
        row: FleetSession,
        attention: FleetSessionAttention,
        context: { finished: boolean },
    ): Promise<void> {
        if (row.provider === 'shell') return;
        const nodeName =
            (await this.nodes.findById(row.nodeId).catch(() => null))?.name ?? 'a computer';
        const who = await this.who(row);
        const prompt = attention.prompt || row.title;

        if (attention.reason !== 'finished') {
            const decision = isFleetSessionDecisionReason(attention.reason);
            try {
                await this.inbox?.sessionAttentionRaised?.({
                    userId: row.userId,
                    kind:
                        attention.reason === 'permission'
                            ? 'approval'
                            : decision
                              ? 'question'
                              : 'notice',
                    title:
                        attention.reason === 'failed'
                            ? `${who} failed on ${nodeName}: ${prompt}`
                            : `${who} asks on ${nodeName}: ${prompt}`,
                    body: `${prompt}\n\n${nodeName} · ${row.title} · ${PROVIDER_NAMES[row.provider] ?? row.provider}`,
                    options: decision
                        ? attention.options.map((option) => ({
                              id: option.id,
                              label: option.label,
                              ...(option.primary ? { recommended: true } : {}),
                          }))
                        : null,
                    agentId: row.agentId ?? null,
                    agentRunId: row.agentRunId ?? null,
                    organizationId: row.organizationId ?? null,
                    sourceMeta: {
                        nodeId: row.nodeId,
                        nodeName,
                        sessionId: row.id,
                        sessionTitle: row.title,
                        provider: row.provider,
                        attentionKey: attention.key,
                    },
                });
            } catch (error) {
                this.warn(row, 'the Inbox item was not filed', error);
            }
        }

        const event =
            attention.reason === 'finished'
                ? context.finished
                    ? ('finished' as const)
                    : null
                : attention.reason === 'failed'
                  ? ('failed' as const)
                  : ('needs-you' as const);
        if (!event || !this.notifications || !this.claimSubject(row.id, event)) return;
        try {
            await this.notifications.notifyFleetSession({
                userId: row.userId,
                event,
                sessionId: row.id,
                attentionKey: attention.key,
                who,
                nodeName,
                text: event === 'finished' ? row.title : prompt,
            });
        } catch (error) {
            this.warn(row, 'the notification was not sent', error);
        }
    }

    async attentionCleared(
        row: FleetSession,
        attention: FleetSessionAttention,
        answer: FleetSessionAttentionAnswer | null,
    ): Promise<void> {
        if (attention.reason === 'finished') return;
        try {
            await this.inbox?.sessionAttentionCleared?.({
                userId: row.userId,
                attentionKey: attention.key,
                reason: !answer && row.state === 'ended' ? 'expired' : 'answered',
                optionId: answer?.optionId ?? null,
                note: answer
                    ? null
                    : isFleetSessionDecisionReason(attention.reason)
                      ? 'Answered in the terminal'
                      : null,
            });
        } catch (error) {
            this.warn(row, 'the Inbox item was not closed', error);
        }
        try {
            await this.notifications?.dismissFleetSession(row.userId, attention.key);
        } catch (error) {
            this.warn(row, 'the notification was not dismissed', error);
        }
    }

    /** "Nina" for an Agent session, the CLI's name for an owner session. */
    private async who(row: FleetSession): Promise<string> {
        if (row.kind === 'agent' && row.agentId && this.agents) {
            try {
                const agent = await this.agents.findById(row.agentId);
                if (agent?.name) return agent.name;
            } catch {
                // the CLI's name below
            }
        }
        return PROVIDER_NAMES[row.provider] ?? 'A session';
    }

    /** At most one notification per subject in the window (FR-39, U13). */
    private claimSubject(sessionId: string, subject: string): boolean {
        const now = this.now();
        for (const [key, at] of this.lastSent) {
            if (now - at > FLEET_SESSION_NOTIFY_DEDUPE_MS) this.lastSent.delete(key);
        }
        const key = `${sessionId}:${subject}`;
        const last = this.lastSent.get(key);
        if (last !== undefined && now - last < FLEET_SESSION_NOTIFY_DEDUPE_MS) return false;
        this.lastSent.set(key, now);
        return true;
    }

    private warn(row: FleetSession, what: string, error: unknown): void {
        this.logger.warn(
            `session ${row.id}: ${what}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
