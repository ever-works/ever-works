import { Injectable } from '@nestjs/common';
import {
    STATS_HEADERS,
    signStatsReportBytes,
    validateStatsReportBytes,
} from '@ever-co/connect-sdk';
import type { SignedStatsReport, WorksStatsV1Report } from '@ever-works/contracts';
import { EverInstanceService } from '@ever-works/agent/ever-instance';
import { InstanceStatsBuildError } from './instance-stats-builder.service';

/**
 * Serialise a validated report ONCE and sign exactly those bytes, with the
 * Ever Platform SDK (`signStatsReportBytes` and the installation's
 * `StatsSigner`).
 *
 * The returned {@link SignedStatsReport} is the only thing that crosses into
 * the `stats-sink` provider, and its `body` is what is stored as the
 * operator's *Last payload*: the bytes signed, the bytes sent and the bytes
 * shown are the same bytes. Nothing re-serialises after this point.
 */
@Injectable()
export class InstanceStatsSigner {
    constructor(private readonly identity: EverInstanceService) {}

    async sign(report: WorksStatsV1Report): Promise<SignedStatsReport> {
        const body = new Uint8Array(Buffer.from(JSON.stringify(report), 'utf8'));
        // The receiver's own checks (size, one key per object, integers only,
        // the schema) on the exact bytes, before the key is touched: a body it
        // would refuse is never signed or sent.
        const check = validateStatsReportBytes(body);
        // `in` narrows here whatever the compiler's null checks (this app runs without them).
        if ('error' in check) throw new InstanceStatsBuildError(check.error);

        const signed = signStatsReportBytes(body, await this.identity.statsSigner(), {
            keyId: true,
        });
        return {
            body: signed.body,
            // The three signature headers only: the sink sets the media type itself.
            headers: {
                [STATS_HEADERS.key]: signed.headers[STATS_HEADERS.key],
                [STATS_HEADERS.signature]: signed.headers[STATS_HEADERS.signature],
                [STATS_HEADERS.key_id]: signed.headers[STATS_HEADERS.key_id],
            },
            reportId: report.report_id,
            period: report.period,
            final: report.final,
        };
    }
}
