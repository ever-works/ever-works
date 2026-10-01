import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AuthSession } from '@ever-works/agent/entities';
import { hashSessionToken } from '../providers/auth-provider.service';
import type { EverIdSignedOutProbe } from '../guards/ever-id-guard.tokens';
import { EverIdReplayService } from './ever-id-replay.service';

/** The current session's facts the Ever ID routes need (never the token). */
export interface EverIdCurrentSession {
    id: string;
    userId: string;
    createdAt: Date;
    expiresAt: Date;
    externalIdentityId: string | null;
    externalSid: string | null;
}

/**
 * APW-12 (Ever ID) — the session operations of plan §5.4.
 *
 * Sessions opened through Ever ID carry `externalIdentityId` (and `externalSid`
 * when the provider sent a `sid`), so this service can end exactly the sessions
 * an identity opened — and never one opened by a password, a magic link or a
 * social provider (FR-35, ACC-12-25), because those rows have `NULL` there.
 *
 * Ending sessions is a plain `DELETE`; when the reason is a provider sign-out
 * notice, the "signed out by Ever ID" marker is written FIRST (plan §5.4), so
 * the next request with that bearer is answered `401 everIdSignedOut` and the
 * web can show S6's notice.
 */
@Injectable()
export class EverIdSessionService implements EverIdSignedOutProbe {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly replay: EverIdReplayService,
    ) {}

    /** The session the request's bearer belongs to, or `null`. */
    async currentSession(headers: Headers): Promise<EverIdCurrentSession | null> {
        const token = bearerOf(headers);
        if (!token) return null;
        const tokenHash = hashSessionToken(token);
        const row =
            (await this.repository().findOne({ where: { tokenHash } })) ??
            // Sessions written by the auth library's own adapter keep the
            // plaintext column until their first bearer use (H-01 migration path).
            (await this.repository().findOne({ where: { token } }));
        if (!row || row.expiresAt.getTime() <= Date.now()) return null;
        return {
            id: row.id,
            userId: row.userId,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            externalIdentityId: row.externalIdentityId ?? null,
            externalSid: row.externalSid ?? null,
        };
    }

    /**
     * End the sessions carrying the provider session id `sid` that were opened
     * by one of `identityIds` (FR-34). Returns how many ended.
     */
    async endBySid(
        sid: string,
        identityIds: readonly string[],
        options: { markSignedOut: boolean } = { markSignedOut: true },
    ): Promise<number> {
        if (!sid || identityIds.length === 0) return 0;
        const rows = await this.repository().find({
            where: { externalSid: sid, externalIdentityId: In([...identityIds]) },
        });
        return this.end(rows, options.markSignedOut);
    }

    /**
     * End every session one identity opened, except `exceptSessionId` (FR-29
     * keeps the current device signed in; FR-34's `sub`-only notice ends all).
     */
    async endByIdentity(
        identityId: string,
        options: { exceptSessionId?: string | null; markSignedOut: boolean },
    ): Promise<number> {
        const rows = await this.repository().find({ where: { externalIdentityId: identityId } });
        const target = options.exceptSessionId
            ? rows.filter((row) => row.id !== options.exceptSessionId)
            : rows;
        return this.end(target, options.markSignedOut);
    }

    /** S6: whether the session this raw bearer belonged to was ended by a sign-out notice. */
    async wasSignedOut(bearer: string): Promise<boolean> {
        if (!bearer) return false;
        return this.replay.isSignedOut(hashSessionToken(bearer));
    }

    /** How many live sessions an identity opened — for the Activity row of a notice. */
    async countForIdentity(identityId: string): Promise<number> {
        return this.repository().count({ where: { externalIdentityId: identityId } });
    }

    private async end(rows: AuthSession[], markSignedOut: boolean): Promise<number> {
        if (rows.length === 0) return 0;
        if (markSignedOut) {
            await this.replay.markSignedOut(
                rows.map((row) => row.tokenHash).filter((hash): hash is string => !!hash),
            );
        }
        const result = await this.repository().delete({ id: In(rows.map((row) => row.id)) });
        return result.affected ?? rows.length;
    }

    private repository() {
        return this.dataSource.getRepository(AuthSession);
    }
}

function bearerOf(headers: Headers): string | null {
    const authorization = headers.get('authorization');
    if (!authorization) return null;
    const [scheme, token] = authorization.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    return token.trim() || null;
}
