import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { EVER_ID_LIMITS } from '@ever-works/contracts';
import { ExternalIdentityRepository } from '@ever-works/agent/database';
import { AuthSession, ExternalIdentity } from '@ever-works/agent/entities';
import { IdentityProviderFacadeService } from '@ever-works/agent/facades';
import { EverIdActivityService, type EverIdRequestContext } from './ever-id-activity.service';
import { EverIdReplayService } from './ever-id-replay.service';
import { EverIdSessionService } from './ever-id-session.service';
import { EVER_ID_TELEMETRY_EVENTS, EverIdTelemetryService } from './ever-id-telemetry.service';

/** A logout token larger than this is refused without being parsed. */
const MAX_LOGOUT_TOKEN_LENGTH = 16_384;

/** FR-34: an invalid notice answers 400 with no detail. */
function invalidNotice(): HttpException {
    return new HttpException(
        { status: 'error', code: 'transaction_invalid', message: 'Invalid logout token.' },
        HttpStatus.BAD_REQUEST,
    );
}

/**
 * The payload of a compact JWS, decoded WITHOUT verification — used only to
 * decide whether verification is needed at all (see below), never to act.
 */
export function decodeUnverifiedPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    try {
        const json = Buffer.from(parts[1], 'base64url').toString('utf8');
        const payload = JSON.parse(json) as unknown;
        return payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * APW-12 (Ever ID) — OpenID Connect back-channel logout (spec FR-33..FR-35,
 * S6, S26; plan §2.3, §5.4).
 *
 * A valid notice ends the sessions Ever ID opened for the `sid` it names (or,
 * with `sub` only, every session that pair opened) — never a session opened by
 * another method (FR-35) — and writes the "signed out by Ever ID" marker first
 * so the person's next request explains what happened (S6). Notices keep
 * working while Ever ID is turned off (FR-5).
 *
 * ## Zero outbound calls on an installation that never used Ever ID
 *
 * Verifying a notice needs the provider's key set. Before verifying, the
 * service asks the database whether ANY identity of the token's (unverified)
 * issuer is connected; when none is, no account can be affected, so the notice
 * is answered `200` exactly as FR-34 answers an unknown `sid`/`sub` — without a
 * key-set fetch. The unverified payload decides only *whether* to verify; every
 * action is taken on the verified claims.
 */
@Injectable()
export class EverIdBackchannelService {
    private readonly logger = new Logger(EverIdBackchannelService.name);

    constructor(
        private readonly facade: IdentityProviderFacadeService,
        private readonly identities: ExternalIdentityRepository,
        private readonly replay: EverIdReplayService,
        private readonly sessions: EverIdSessionService,
        private readonly activity: EverIdActivityService,
        private readonly telemetry: EverIdTelemetryService,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    async handle(
        logoutToken: unknown,
        ctx: EverIdRequestContext,
    ): Promise<{ sessionsEnded: number }> {
        if (
            typeof logoutToken !== 'string' ||
            !logoutToken ||
            logoutToken.length > MAX_LOGOUT_TOKEN_LENGTH
        ) {
            throw invalidNotice();
        }
        const unverified = decodeUnverifiedPayload(logoutToken);
        if (!unverified || typeof unverified.iss !== 'string' || !unverified.iss)
            throw invalidNotice();

        // No identity of this issuer is connected: nothing can be affected (S26).
        if (!(await this.identities.existsForIssuer(unverified.iss))) {
            return { sessionsEnded: 0 };
        }

        let claims: Awaited<ReturnType<IdentityProviderFacadeService['verifyLogoutToken']>>;
        try {
            claims = await this.facade.verifyLogoutToken(logoutToken);
        } catch (error) {
            const code =
                (error as { code?: unknown; reason?: unknown })?.code ??
                (error as { reason?: unknown })?.reason;
            this.logger.warn(
                `Ever ID sign-out notice refused: ${typeof code === 'string' ? code : 'invalid'}`,
            );
            await this.emitIfEnabled('invalid', 0);
            throw invalidNotice();
        }

        // FR-33: a `jti` seen in the last 600 seconds is a replay (ACC-12-24).
        if (
            !(await this.replay.consumeOnce(
                'logout-jti',
                `${claims.issuer}|${claims.jti}`,
                EVER_ID_LIMITS.replayWindowSeconds,
            ))
        ) {
            await this.emitIfEnabled('invalid', 0);
            throw invalidNotice();
        }

        const affected = await this.affectedIdentities(claims.issuer, claims.subject, claims.sid);
        let total = 0;
        for (const identity of affected) {
            const ended = claims.sid
                ? await this.sessions.endBySid(claims.sid, [identity.id], { markSignedOut: true })
                : await this.sessions.endByIdentity(identity.id, { markSignedOut: true });
            total += ended;
            this.activity.signedOutElsewhere(
                identity.userId,
                identity.id,
                ended,
                claims.sid ? 'sid' : 'sub',
                ctx,
            );
        }

        await this.facade.recordLogoutNotice();
        await this.emitIfEnabled(total > 0 ? 'ended' : 'unknown', total);
        return { sessionsEnded: total };
    }

    /**
     * The identities a verified notice is about: by `sub` when it names one,
     * otherwise the identities behind the sessions carrying its `sid` — always
     * restricted to the notice's issuer.
     */
    private async affectedIdentities(
        issuer: string,
        subject: string | null,
        sid: string | null,
    ): Promise<ExternalIdentity[]> {
        if (subject) {
            const identity = await this.identities.findByIssuerSubject(issuer, subject);
            return identity ? [identity] : [];
        }
        if (!sid) return [];
        const sessions = await this.dataSource
            .getRepository(AuthSession)
            .find({ where: { externalSid: sid } });
        const ids = [
            ...new Set(
                sessions
                    .map((session) => session.externalIdentityId)
                    .filter((id): id is string => typeof id === 'string' && id.length > 0),
            ),
        ];
        if (ids.length === 0) return [];
        return this.dataSource
            .getRepository(ExternalIdentity)
            .find({ where: { id: In(ids), issuer } });
    }

    private async emitIfEnabled(result: 'ended' | 'unknown' | 'invalid', sessionsEnded: number) {
        if (await this.facade.isEnabled().catch(() => false)) {
            this.telemetry.emit(EVER_ID_TELEMETRY_EVENTS.BACKCHANNEL_RECEIVED, {
                result,
                sessionsEnded,
            });
        }
    }
}
