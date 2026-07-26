import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Invoice, InvoiceLineItem, InvoiceStatus } from '@src/entities/invoice.entity';

/**
 * One provider invoice/receipt, as read from a signature-verified event.
 * Amounts NEVER come from a client — see `BillingService.handleWebhook`.
 */
export interface InvoiceMirrorWrite {
    userId: string;
    organizationId?: string | null;
    tenantId?: string | null;
    provider: string;
    providerInvoiceId: string;
    number?: string | null;
    status: InvoiceStatus;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    subtotalCents: number;
    totalCents: number;
    amountPaidCents?: number;
    currency: string;
    hostedUrl?: string | null;
    pdfUrl?: string | null;
    lineItems?: InvoiceLineItem[] | null;
    issuedAt?: Date | null;
}

export interface InvoiceListQuery {
    skip: number;
    take: number;
}

/**
 * Invoice mirror (billing PRD §5.3(4)). Writes happen only on the webhook
 * path; every read is owner-scoped by `userId` — there is deliberately no
 * "find by id" that skips the owner filter.
 */
@Injectable()
export class InvoiceRepository {
    constructor(
        @InjectRepository(Invoice)
        private readonly repository: Repository<Invoice>,
    ) {}

    /** Insert-or-update keyed on (provider, providerInvoiceId). */
    async mirror(write: InvoiceMirrorWrite): Promise<Invoice> {
        const existing = await this.repository.findOne({
            where: { provider: write.provider, providerInvoiceId: write.providerInvoiceId },
        });

        const values = {
            userId: write.userId,
            organizationId: write.organizationId ?? null,
            tenantId: write.tenantId ?? null,
            provider: write.provider,
            providerInvoiceId: write.providerInvoiceId,
            number: write.number ?? null,
            status: write.status,
            periodStart: write.periodStart ?? null,
            periodEnd: write.periodEnd ?? null,
            subtotalCents: write.subtotalCents,
            totalCents: write.totalCents,
            amountPaidCents: write.amountPaidCents ?? 0,
            currency: write.currency,
            hostedUrl: write.hostedUrl ?? null,
            pdfUrl: write.pdfUrl ?? null,
            lineItems: write.lineItems ?? null,
            issuedAt: write.issuedAt ?? null,
        };

        if (existing) {
            await this.repository.update({ id: existing.id }, values);
            return (await this.repository.findOne({ where: { id: existing.id } })) ?? existing;
        }
        return this.repository.save(this.repository.create(values));
    }

    /** Owner-scoped, newest-first. */
    async findForUser(
        userId: string,
        query: InvoiceListQuery,
    ): Promise<{ invoices: Invoice[]; total: number }> {
        const [invoices, total] = await this.repository.findAndCount({
            where: { userId },
            order: { issuedAt: 'DESC', createdAt: 'DESC' },
            skip: query.skip,
            take: query.take,
        });
        return { invoices, total };
    }

    /** Owner-scoped single read — the userId filter is not optional. */
    findOneForUser(userId: string, id: string): Promise<Invoice | null> {
        return this.repository.findOne({ where: { id, userId } });
    }
}
