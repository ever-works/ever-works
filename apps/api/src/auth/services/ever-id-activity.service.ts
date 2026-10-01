import { Injectable } from '@nestjs/common';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';

/** The request facts every sign-in row carries, as the other sign-in rows do (FR-49). */
export interface EverIdRequestContext {
    ipAddress: string | null;
    userAgent: string | null;
}

/**
 * APW-12 (Ever ID) — the Activity rows of spec FR-49 / plan §5.6, written in one
 * place so their shape cannot drift.
 *
 * Every row carries IP address and user agent like the existing sign-in rows,
 * the identity's display name where the row is about an identity, and NEVER a
 * token, an authorization code, a `state`, a subject or an issuer. Writes are
 * best-effort (`.catch(() => {})`), exactly like the existing auth rows: a
 * failed audit write never fails a sign-in.
 */
@Injectable()
export class EverIdActivityService {
    constructor(private readonly activityLog: ActivityLogService) {}

    signedIn(userId: string, identityId: string, displayName: string, ctx: EverIdRequestContext) {
        this.write({
            userId,
            actionType: ActivityActionType.USER_LOGIN,
            action: 'user.login.ever-id',
            summary: 'Signed in with Ever ID',
            metadata: { provider: 'ever-id', identityId, displayName },
            ctx,
        });
    }

    signedUp(userId: string, identityId: string, displayName: string, ctx: EverIdRequestContext) {
        this.write({
            userId,
            actionType: ActivityActionType.USER_SIGNUP,
            action: 'user.signup.ever-id',
            summary: 'Created an account with Ever ID',
            metadata: { identityId, displayName },
            ctx,
        });
    }

    signedInFromTerminal(
        userId: string,
        identityId: string,
        clientKind: 'cli' | 'node' | 'unknown',
        displayName: string,
        ctx: EverIdRequestContext,
    ) {
        this.write({
            userId,
            actionType: ActivityActionType.USER_LOGIN,
            action: 'user.login.ever-id.device',
            summary: 'Signed in from a terminal with Ever ID',
            metadata: { identityId, clientKind, displayName },
            ctx,
        });
    }

    connected(
        userId: string,
        identityId: string,
        emailsDiffer: boolean,
        displayName: string,
        ctx: EverIdRequestContext,
    ) {
        this.write({
            userId,
            actionType: ActivityActionType.IDENTITY_LINKED,
            action: 'auth.ever_id.linked',
            summary: 'Connected Ever ID',
            metadata: { identityId, emailsDiffer, displayName },
            ctx,
        });
    }

    disconnected(
        userId: string,
        identityId: string,
        sessionsEnded: number,
        displayName: string,
        ctx: EverIdRequestContext,
    ) {
        this.write({
            userId,
            actionType: ActivityActionType.IDENTITY_UNLINKED,
            action: 'auth.ever_id.unlinked',
            summary: 'Disconnected Ever ID',
            metadata: { identityId, sessionsEnded, displayName },
            ctx,
        });
    }

    signedOutElsewhere(
        userId: string,
        identityId: string,
        sessionsEnded: number,
        by: 'sid' | 'sub',
        ctx: EverIdRequestContext,
    ) {
        this.write({
            userId,
            actionType: ActivityActionType.USER_LOGOUT,
            action: 'auth.ever_id.backchannel_logout',
            summary: 'Signed out of Ever ID elsewhere',
            metadata: { identityId, sessionsEnded, by },
            ctx,
        });
    }

    delegatedRead(
        userId: string,
        identityId: string,
        clientId: string,
        clientName: string,
        ctx: EverIdRequestContext,
    ) {
        this.write({
            userId,
            actionType: ActivityActionType.DELEGATED_ACCESS,
            action: 'auth.ever_id.delegated_read',
            summary: `${clientName} read your App Works`,
            metadata: { identityId, clientId, clientName },
            ctx,
        });
    }

    configChanged(userId: string, fields: string[], ctx: EverIdRequestContext) {
        this.write({
            userId,
            actionType: ActivityActionType.IDENTITY_PROVIDER_CONFIG_CHANGED,
            action: 'auth.ever_id.config_changed',
            summary: 'Ever ID configuration changed',
            metadata: { fields: [...fields] },
            ctx,
        });
    }

    /**
     * A refused sign-in for a KNOWN account (for example a deactivated one, S22).
     * A refusal that resolved no account is never written here — Activity rows
     * belong to an account — and is counted by the telemetry counter instead,
     * without a user and without the e-mail address (FR-50).
     */
    signInRefused(reason: string, ctx: EverIdRequestContext, userId: string) {
        this.write({
            userId,
            actionType: ActivityActionType.USER_LOGIN,
            action: 'auth.ever_id.sign_in_refused',
            summary: 'Sign-in with Ever ID refused',
            metadata: { reason },
            status: ActivityStatus.FAILED,
            ctx,
        });
    }

    private write(row: {
        userId: string;
        actionType: ActivityActionType;
        action: string;
        summary: string;
        metadata: Record<string, unknown>;
        status?: ActivityStatus;
        ctx: EverIdRequestContext;
    }) {
        this.activityLog
            .log({
                userId: row.userId,
                actionType: row.actionType,
                action: row.action,
                status: row.status ?? ActivityStatus.COMPLETED,
                summary: row.summary,
                metadata: row.metadata,
                ipAddress: row.ctx.ipAddress ?? undefined,
                userAgent: row.ctx.userAgent ?? undefined,
            })
            .catch(() => {});
    }
}
