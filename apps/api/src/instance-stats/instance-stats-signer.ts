import { Injectable } from '@nestjs/common';
import {
    EVER_STATS_KEY_HEADER,
    EVER_STATS_KEY_ID_HEADER,
    EVER_STATS_SIGNATURE_HEADER,
    EVER_STATS_SIGNATURE_PREFIX,
    type SignedStatsReport,
    type WorksStatsV1Report,
} from '@ever-works/contracts';
import { EverInstanceService, validateStatsReportBody } from '@ever-works/agent/ever-instance';
import { InstanceStatsBuildError } from './instance-stats-builder.service';

/**
 * Serialise a validated report ONCE and sign exactly those bytes.
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
        // the schema) on the exact bytes — a body it would refuse is never sent.
        const check = validateStatsReportBody(body);
        if (!check.ok) throw new InstanceStatsBuildError(check.errors);

        const { signature, publicKey, keyId } = await this.identity.sign(body);
        return {
            body,
            headers: {
                [EVER_STATS_KEY_HEADER]: publicKey,
                [EVER_STATS_SIGNATURE_HEADER]: `${EVER_STATS_SIGNATURE_PREFIX}${signature}`,
                [EVER_STATS_KEY_ID_HEADER]: keyId,
            },
            reportId: report.report_id,
            period: report.period,
            final: report.final,
        };
    }
}
