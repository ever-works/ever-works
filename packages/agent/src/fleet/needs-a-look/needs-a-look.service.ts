import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    NEEDS_A_LOOK_MAX_ITEMS,
    normalizeNeedsALookItem,
    sortNeedsALook,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import {
    NEEDS_A_LOOK_PRODUCERS,
    NEEDS_A_LOOK_PRODUCER_TIMEOUT_MS,
    type NeedsALookContext,
    type NeedsALookProducer,
} from './needs-a-look.producer';

/** What one read of the registry answers. */
export interface NeedsALookResult {
    items: NeedsALookItem[];
    /** True when at least one producer failed or timed out and was skipped (spec U11). */
    partial: boolean;
}

/**
 * Fleet hub (FL-01) — the "needs a look" registry: fans one read out to
 * every registered producer and folds the answers into the one sorted list
 * the hub renders (CONTRACTS §4.6, R-23).
 *
 * Degrades per producer, never per page: a producer that throws, answers
 * something that is not a list, or does not answer within the timeout is
 * skipped and logged with its id, the result is marked `partial`, and every
 * other producer's items still render (spec U11). An item is kept only when
 * it is well-formed (`normalizeNeedsALookItem`) and names one of the nodes
 * the read was for — so a producer bug can never put a machine the caller
 * may not see on their screen. Items are de-duplicated by id (first producer
 * wins), sorted critical → warn → info → oldest first, and capped.
 *
 * Producers register themselves (`register`, typically from their own
 * `onModuleInit`) or arrive through the optional `NEEDS_A_LOOK_PRODUCERS`
 * token; both feed one list, in registration order.
 */
@Injectable()
export class NeedsALookService {
    private readonly logger = new Logger(NeedsALookService.name);
    private readonly producers: NeedsALookProducer[] = [];

    constructor(
        @Optional()
        @Inject(NEEDS_A_LOOK_PRODUCERS)
        producers?: readonly NeedsALookProducer[] | null,
    ) {
        for (const producer of producers ?? []) this.register(producer);
    }

    /** Add a producer. Registering the same id twice keeps the first (idempotent on re-init). */
    register(producer: NeedsALookProducer): void {
        if (!producer || typeof producer.produce !== 'function') return;
        if (this.producers.some((existing) => existing.id === producer.id)) return;
        this.producers.push(producer);
    }

    /** The registered producer ids, in registration order (diagnostics and tests). */
    registered(): readonly string[] {
        return this.producers.map((producer) => producer.id);
    }

    /** Ask every producer about `nodes` and fold the answers. Never throws. */
    async forNodes(
        nodes: readonly FleetNodeView[],
        context: Pick<NeedsALookContext, 'userId'> & Partial<NeedsALookContext>,
    ): Promise<NeedsALookResult> {
        if (nodes.length === 0 || this.producers.length === 0) {
            return { items: [], partial: false };
        }
        const ctx: NeedsALookContext = { userId: context.userId, now: context.now ?? new Date() };
        const known = new Set(nodes.map((node) => node.id));

        const answers = await Promise.all(
            this.producers.map((producer) => this.ask(producer, nodes, ctx)),
        );

        let partial = false;
        const seen = new Set<string>();
        const items: NeedsALookItem[] = [];
        for (const answer of answers) {
            if (answer === null) {
                partial = true;
                continue;
            }
            for (const raw of answer) {
                const item = normalizeNeedsALookItem(raw);
                // Keyed on node AND id: two producers that both name a problem
                // `disk-low` on different nodes must not swallow each other.
                const key = item ? `${item.nodeId}:${item.id}` : '';
                if (!item || !known.has(item.nodeId) || seen.has(key)) continue;
                seen.add(key);
                items.push(item);
            }
        }
        return { items: sortNeedsALook(items).slice(0, NEEDS_A_LOOK_MAX_ITEMS), partial };
    }

    /** One producer's answer, or null when it failed, timed out or answered something that is not a list. */
    private async ask(
        producer: NeedsALookProducer,
        nodes: readonly FleetNodeView[],
        ctx: NeedsALookContext,
    ): Promise<readonly unknown[] | null> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), NEEDS_A_LOOK_PRODUCER_TIMEOUT_MS);
                timer.unref?.();
            });
            const answer = await Promise.race([
                Promise.resolve().then(() => producer.produce(nodes, ctx)),
                timeout,
            ]);
            if (answer === 'timeout') {
                this.logger.warn(
                    `needs-a-look producer ${producer.id} did not answer within ${NEEDS_A_LOOK_PRODUCER_TIMEOUT_MS} ms; skipped`,
                );
                return null;
            }
            if (!Array.isArray(answer)) {
                this.logger.warn(
                    `needs-a-look producer ${producer.id} answered a non-list; skipped`,
                );
                return null;
            }
            return answer;
        } catch (error) {
            this.logger.warn(
                `needs-a-look producer ${producer.id} failed and was skipped: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
