import { PortableDateColumn } from './_types';
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Invoice mirror (billing PRD §3.5 / §5.3(4)) — a local, owner-scoped
 * copy of the payment provider's invoices and top-up receipts, written
 * ONLY by the signature-verified webhook handler.
 *
 * Why mirror instead of proxying the provider API on every page load:
 *
 *   - The Billing page's invoice table renders even when the provider is
 *     briefly unreachable.
 *   - Admin/export queries can join invoices against platform rows.
 *   - Amounts are read from the provider EVENT, never from a client, so
 *     the mirror is authoritative for what was actually charged.
 *
 * `providerInvoiceId` is UNIQUE: webhook re-delivery updates the existing
 * row rather than inserting a duplicate. `hostedUrl` / `pdfUrl` are the
 * provider's own signed links — we store the URL, never the document.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; the userId FK lives in the migration
 * (`1784300000000-CreateBillingProfilesAndInvoices`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this repo
 * has no `autoLoadEntities`; a forFeature'd-but-unregistered entity
 * throws EntityMetadataNotFoundError on first query.
 */
export enum InvoiceStatus {
    DRAFT = 'draft',
    OPEN = 'open',
    PAID = 'paid',
    VOID = 'void',
    UNCOLLECTIBLE = 'uncollectible',
    /** Fully or partially refunded / charged back. */
    REFUNDED = 'refunded',
}

/** One provider line item, projected down to what the UI renders. */
export interface InvoiceLineItem {
    description: string;
    quantity: number;
    amountCents: number;
}

@Entity({ name: 'invoices' })
@Index('idx_invoices_user_issued', ['userId', 'issuedAt'])
@Index('idx_invoices_provider_ref', ['provider', 'providerInvoiceId'], { unique: true })
export class Invoice {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner — every read path filters on this (owner-scoped list). */
    @Column({ type: 'uuid' })
    userId: string;

    // Tenant + Organization scope columns (Tier C denormalization
    // pattern). Raw uuid references — no @ManyToOne, EW-654 cycle rule.
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'varchar', length: 32 })
    provider: string;

    /** Provider invoice / receipt identifier. UNIQUE per provider. */
    @Column({ type: 'varchar', length: 128 })
    providerInvoiceId: string;

    /** Human-facing invoice number from the provider, when it issues one. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    number?: string | null;

    @Column({ type: 'varchar', length: 16 })
    status: InvoiceStatus;

    @PortableDateColumn({ nullable: true })
    periodStart?: Date | null;

    @PortableDateColumn({ nullable: true })
    periodEnd?: Date | null;

    @Column({ type: 'int' })
    subtotalCents: number;

    @Column({ type: 'int' })
    totalCents: number;

    /** What the provider reports as actually collected. */
    @Column({ type: 'int', default: 0 })
    amountPaidCents: number;

    @Column({ type: 'varchar', length: 8 })
    currency: string;

    /** Provider-hosted invoice page (signed link). */
    @Column({ type: 'varchar', length: 512, nullable: true })
    hostedUrl?: string | null;

    /** Provider-hosted PDF (signed link). */
    @Column({ type: 'varchar', length: 512, nullable: true })
    pdfUrl?: string | null;

    @Column({ type: 'simple-json', nullable: true })
    lineItems?: InvoiceLineItem[] | null;

    @PortableDateColumn({ nullable: true })
    issuedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
