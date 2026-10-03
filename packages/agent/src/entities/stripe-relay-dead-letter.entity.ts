import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

export enum StripeRelayDeadLetterStatus {
    /** Not delivered to its directory yet. Counts toward the relay health probe. */
    OPEN = 'open',
    /** Delivered later (a Stripe retry or an operator replay), or dismissed by an operator. */
    RESOLVED = 'resolved',
}

/** How an open dead letter was closed. */
export enum StripeRelayDeadLetterResolution {
    /** A later Stripe retry of the same event reached the directory. */
    STRIPE_RETRY = 'stripe-retry',
    /** A platform admin replayed the stored payload and the directory accepted it. */
    REPLAYED = 'replayed',
    /** A platform admin closed it by hand (for example after fulfilling manually). */
    DISMISSED = 'dismissed',
}

/**
 * One Stripe event the shared webhook relay could NOT deliver to its directory.
 *
 * Before this table the relay answered Stripe `200` for every event it could
 * not route (unknown Work, missing site, missing secret, a site 4xx) and kept
 * only a log line, and pod logs live for about an hour. A paid sponsor event
 * lost that way was lost for good. Now every event that carries a `work_id`
 * and is not confirmed delivered lands here, keyed by the Stripe event id:
 *
 *  - `disposition = 'retry'`: the relay also answered Stripe 503, so Stripe
 *    keeps retrying for about three days; a later successful delivery
 *    resolves the row automatically.
 *  - `disposition = 'unroutable'`: retrying cannot help (a 409 ownership
 *    mismatch, a 400 malformed body, an unknown Work, an SSRF refusal), so the
 *    row is the only record, and an operator replays or dismisses it.
 *
 * `payload` is the verbatim body Stripe signed. The replay tool forwards those
 * exact bytes, so the directory's digest check and its event-id dedup behave
 * exactly as they would for the original delivery. It holds what Stripe sent
 * (customer email and name on invoice events, never card data), which is why
 * the admin listing never returns it.
 *
 * Rows are never deleted by the application: a resolved row is the audit
 * trail of what went wrong and how it was closed.
 *
 * NOTE: also registered in `database/_entities-inventory.ts` (no
 * `autoLoadEntities` in this repo). Migration:
 * `1792310000000-CreateStripeRelayDeadLetters`.
 */
@Entity({ name: 'stripe_relay_dead_letters' })
@Index('idx_stripe_relay_dead_letters_event', ['eventId'], { unique: true })
@Index('idx_stripe_relay_dead_letters_status_failed', ['status', 'lastFailedAt'])
export class StripeRelayDeadLetter {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Stripe event id (`evt_...`). One row per event, however many attempts. */
    @Column({ type: 'varchar', length: 255 })
    eventId: string;

    /** Stripe event type, e.g. `invoice.payment_succeeded`. */
    @Column({ type: 'varchar', length: 100 })
    eventType: string;

    /**
     * The `work_id` the event named. Plain varchar, not a uuid FK: an unknown
     * or malformed id is exactly one of the failures this table records.
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    workId?: string | null;

    /** Stripe `livemode` of the event. */
    @Column({ type: 'boolean', default: false })
    livemode: boolean;

    /** The relay's latest decision for this event: `retry` or `unroutable`. */
    @Column({ type: 'varchar', length: 16 })
    disposition: string;

    /** The relay's latest classification, e.g. `site_404` or `not_provisioned`. */
    @Column({ type: 'varchar', length: 64 })
    reason: string;

    /** HTTP status the directory answered on the latest attempt, when it answered. */
    @Column({ type: 'int', nullable: true })
    siteStatus?: number | null;

    /** Failed attempts so far (Stripe deliveries plus operator replays). */
    @Column({ type: 'int', default: 1 })
    attempts: number;

    @Column({ type: 'varchar', length: 16, default: StripeRelayDeadLetterStatus.OPEN })
    status: StripeRelayDeadLetterStatus;

    @Column({ type: 'varchar', length: 32, nullable: true })
    resolution?: StripeRelayDeadLetterResolution | null;

    /** The verbatim body Stripe signed. Never returned by any API. */
    @Column({ type: 'text' })
    payload: string;

    @PortableDateColumn()
    firstFailedAt: Date;

    @PortableDateColumn()
    lastFailedAt: Date;

    @PortableDateColumn({ nullable: true })
    resolvedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
