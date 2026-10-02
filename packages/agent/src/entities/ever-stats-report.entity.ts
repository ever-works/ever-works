import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type {
    StatsSendErrorCode,
    StatsSendFieldError,
    StatsSendStatus,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/** How many send attempts are kept; older rows are pruned after each attempt. */
export const EVER_STATS_REPORTS_KEPT = 12;

/**
 * One attempt to send an anonymous usage statistics report — the operator's
 * audit trail behind *Last payload* in Settings.
 *
 * `payload` holds the EXACT bytes that were signed and posted (UTF-8 text of
 * the JSON body), so what the operator reads is byte-identical to what left
 * the instance. Only the last {@link EVER_STATS_REPORTS_KEPT} rows are kept.
 *
 * `errors` holds the receiver's `{path, code}` pairs for a refused report: JSON
 * pointers into the published schema and closed codes, never a value.
 */
@Entity({ name: 'ever_stats_report' })
@Index('idx_ever_stats_report_attempted', ['attemptedAt'])
export class EverStatsReport {
    /** The report's own `report_id` (UUID v4, minted per report). */
    @PrimaryColumn({ type: 'uuid' })
    reportId: string;

    /** `YYYY-MM` — the UTC month the report describes. */
    @Column({ type: 'varchar', length: 7 })
    period: string;

    /** `true` = the closed previous month, re-sent once on days 1-3. */
    @Column({ type: 'boolean', default: false })
    final: boolean;

    /** The exact body that was posted. */
    @Column({ type: 'text' })
    payload: string;

    @Column({ type: 'int' })
    bytes: number;

    /** `sent` | `rejected` | `failed`. */
    @Column({ type: 'varchar', length: 16 })
    status: StatsSendStatus;

    @Column({ type: 'int', nullable: true })
    httpStatus?: number | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    errorCode?: StatsSendErrorCode | null;

    @Column({ type: 'simple-json', nullable: true })
    errors?: StatsSendFieldError[] | null;

    /** Which attempt of the retry ladder this was (1 = first). */
    @Column({ type: 'int', default: 1 })
    attempt: number;

    /** The module version that built the report (a `rejected` one is retried only after it changes). */
    @Column({ type: 'varchar', length: 14 })
    moduleVersion: string;

    @PortableDateColumn()
    attemptedAt: Date;
}
