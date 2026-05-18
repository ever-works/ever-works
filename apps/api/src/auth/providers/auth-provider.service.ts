import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { UserRepository } from '@ever-works/agent/database';
import { AuthSession, User } from '@ever-works/agent/entities';
import type { AuthenticatedUser, TokenResponse } from '../types/auth.types';
import { AUTH_RUNTIME_INSTANCE } from './auth-provider.constants';
import { AuthProvider } from './auth-provider.abstract';
// `createAuthRuntimeInstance` is only referenced in a `typeof` position so
// the import is type-only — keeps better-auth's ESM bundle out of the
// service's runtime evaluation (matters for jest, which has cjs-only
// transforms here).
import type { createAuthRuntimeInstance } from './auth-runtime.instance';
// L-07: imported from the standalone helper file so we don't load
// better-auth's ESM bundle at service-spec evaluation time.
import { getBcryptCost, passwordNeedsRehash } from './bcrypt-cost';
import type { AuthRuntimeContext, AuthRuntimeUser } from './auth-provider.types';
import { AuthSyncService } from './auth-sync.service';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

/**
 * H-01 (sessions): derive the at-rest fingerprint of a session bearer. The
 * raw token has 192+ bits of entropy (`randomBytes(24+)`), so a plain
 * `sha256` with no salt is sufficient — collisions are not a realistic risk
 * and adding a salt would defeat O(1) lookup-by-hash. Mirrors the helper in
 * `auth.service.ts` for verification / reset tokens.
 */
function hashSessionToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * H-17 (rest): per-user lockout knobs. Defaults give a real user 5 typos
 * before a 15 min cool-off — enough to keep the support load low while
 * still locking out a sustained credential-stuffing run targeting a
 * single account.
 */
function getLockoutThreshold(): number {
    const raw = Number(process.env.LOGIN_LOCKOUT_THRESHOLD);
    if (!Number.isFinite(raw) || raw <= 0) return 5;
    return Math.floor(raw);
}

function getLockoutDurationMs(): number {
    const raw = Number(process.env.LOGIN_LOCKOUT_DURATION_MS);
    if (!Number.isFinite(raw) || raw <= 0) return 15 * 60 * 1000;
    return Math.floor(raw);
}

@Injectable()
export class AuthProviderService extends AuthProvider {
    private readonly logger = new Logger(AuthProviderService.name);

    constructor(
        @Inject(AUTH_RUNTIME_INSTANCE)
        private readonly auth: ReturnType<typeof createAuthRuntimeInstance>,
        private readonly userRepository: UserRepository,
        private readonly authSyncService: AuthSyncService,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {
        super();
    }

    async authenticate(headers: Headers): Promise<AuthenticatedUser | null> {
        const bearerToken = this.getBearerToken(headers);
        if (bearerToken) {
            const session = await this.findSessionRecord(bearerToken);
            if (!session) {
                return null;
            }

            if (session.expiresAt.getTime() <= Date.now()) {
                await this.deleteSessionRecord(bearerToken);
                return null;
            }

            const user = await this.assertActiveUser(session.userId);
            return this.mapAuthenticatedUserFromUser(user);
        }

        const session = await this.auth.api.getSession({ headers });
        if (!session) {
            return null;
        }

        if ((session.user as AuthRuntimeUser).isActive === false) {
            await this.signOutAll(session.user.id);
            throw new UnauthorizedException('User account is suspended');
        }

        return this.mapAuthenticatedUser(session.user as AuthRuntimeUser);
    }

    async signInEmail(email: string, password: string, headers: Headers): Promise<TokenResponse> {
        const existingUser = await this.findUserRowByEmail(email);

        // H-17 (rest): short-circuit on lockout BEFORE invoking Better Auth's
        // signInEmail. This deliberately leaks that the email row exists when
        // it's currently locked — same posture documented in the audit spec
        // ("the simpler version: show the locked message regardless if email
        // matches a row that's locked"). The existing /auth/login per-IP
        // throttle keeps enumeration cost high; full anti-enumeration would
        // need a constant-time hashing branch on the not-found path and is
        // out of scope here.
        if (existingUser && this.isCurrentlyLocked(existingUser)) {
            throw new UnauthorizedException(this.buildLockoutMessage(existingUser));
        }

        if (existingUser?.password) {
            await this.authSyncService.ensureCredentialAccount(
                existingUser.id,
                existingUser.password,
            );
        }

        // H-17 (rest): Better Auth's `signInEmail` throws on bad credentials
        // (or any other failure). Treat every throw as a failed-login event
        // against the row we just resolved by email, then rethrow so the
        // existing error surface is preserved.
        let result: Awaited<ReturnType<typeof this.auth.api.signInEmail>>;
        try {
            result = await this.auth.api.signInEmail({
                headers,
                body: {
                    email,
                    password,
                    rememberMe: true,
                },
            });
        } catch (err) {
            if (existingUser) {
                await this.recordFailedLogin(existingUser);
            }
            throw err;
        }

        const user = await this.assertActiveUser(result.user.id);

        // H-17 (rest): credential check passed — clear any stale counter /
        // lock window so the user starts fresh on the next failed attempt.
        // We only reset when the row we resolved by email actually had a
        // counter worth clearing; this avoids one redundant write per
        // successful signIn on a brand-new account.
        if (existingUser && (existingUser.failedLoginAttempts > 0 || existingUser.lockedUntil)) {
            await this.resetLockoutState(user.id);
        }

        const passwordHash = await this.authSyncService.getCredentialPasswordHash(user.id);
        if (passwordHash) {
            await this.userRepository.update(user.id, {
                password: passwordHash,
                lastLoginAt: new Date(),
                registrationProvider: 'local',
            });

            // L-07 (rehash-on-login): the credential check just succeeded, so
            // we have plaintext access. If the stored hash is below the
            // configured cost (e.g. legacy `$2b$10$…` rows after we bumped
            // BCRYPT_COST to 12), rehash at the new cost and write it back
            // out-of-band so existing users migrate seamlessly on next login
            // without a forced password reset.
            //
            // Crucially this is NOT awaited — the DB write must not block the
            // signInEmail return. If the write fails we just log and try
            // again on the next login.
            if (passwordNeedsRehash(passwordHash)) {
                void this.rehashCredentialPassword(user.id, password).catch((err) => {
                    this.logger.warn(
                        `rehash-on-login failed for user=${user.id}: ${err?.message ?? err}`,
                    );
                });
            }
        }

        if (!result.token) {
            throw new UnauthorizedException('Failed to establish authenticated session');
        }

        return {
            access_token: result.token,
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
            },
        };
    }

    async signUpEmail(
        name: string,
        email: string,
        password: string,
        headers: Headers,
    ): Promise<TokenResponse> {
        const result = await this.auth.api.signUpEmail({
            headers,
            body: {
                name,
                email,
                password,
                rememberMe: true,
            },
        });

        const passwordHash = await this.authSyncService.getCredentialPasswordHash(result.user.id);
        if (passwordHash) {
            await this.userRepository.update(result.user.id, {
                password: passwordHash,
                registrationProvider: 'local',
                isActive: true,
            });
        }

        if (result.token) {
            const user = await this.assertActiveUser(result.user.id);
            return {
                access_token: result.token,
                user: {
                    id: user.id,
                    email: user.email,
                    username: user.username,
                },
            };
        }

        return this.issueSession(result.user.id);
    }

    async issueSession(
        userId: string,
        clientFingerprint?: { ipAddress?: string | null; userAgent?: string | null },
    ): Promise<TokenResponse> {
        const user = await this.assertActiveUser(userId);
        // H-01 (sessions): `createSessionRecord` returns a non-persistent
        // `rawToken` extra property. The persisted row stores only the hash.
        const session = await this.createSessionRecord(user.id, clientFingerprint);

        return {
            access_token: session.rawToken,
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
            },
        };
    }

    async changePassword(
        currentPassword: string,
        newPassword: string,
        headers: Headers,
    ): Promise<void> {
        const user = await this.requireAuthenticatedUser(headers);
        const passwordHash = await this.authSyncService.getCredentialPasswordHash(user.id);
        if (!passwordHash) {
            throw new UnauthorizedException('Password login is not configured for this account');
        }

        const isMatch = await bcrypt.compare(currentPassword, passwordHash);
        if (!isMatch) {
            throw new UnauthorizedException('Current password is incorrect');
        }

        await this.setPassword(user.id, newPassword);
    }

    async setPassword(userId: string, newPassword: string): Promise<void> {
        const context = await this.getContext();
        const passwordHash = await context.password.hash(newPassword);
        await this.authSyncService.syncCredentialPassword(userId, passwordHash);
        await this.userRepository.update(userId, {
            password: passwordHash,
        });
    }

    async signOut(headers: Headers): Promise<void> {
        const bearerToken = this.getBearerToken(headers);
        if (bearerToken) {
            await this.deleteSessionRecord(bearerToken);
            return;
        }

        await this.auth.api.signOut({ headers });
    }

    async signOutAll(userId: string): Promise<void> {
        await this.getSessionRepository().delete({ userId });
    }

    private async getContext(): Promise<AuthRuntimeContext> {
        return (await this.auth.$context) as AuthRuntimeContext;
    }

    private async requireAuthenticatedUser(headers: Headers) {
        const bearerToken = this.getBearerToken(headers);
        if (bearerToken) {
            const session = await this.findSessionRecord(bearerToken);
            if (!session) {
                throw new UnauthorizedException('Invalid session');
            }

            if (session.expiresAt.getTime() <= Date.now()) {
                await this.deleteSessionRecord(bearerToken);
                throw new UnauthorizedException('Session expired');
            }

            return this.assertActiveUser(session.userId);
        }

        const session = await this.auth.api.getSession({ headers });
        if (!session) {
            throw new UnauthorizedException('Missing session token');
        }

        if ((session.user as AuthRuntimeUser).isActive === false) {
            await this.signOutAll(session.user.id);
            throw new UnauthorizedException('User account is suspended');
        }

        return this.assertActiveUser(session.user.id);
    }

    private async assertActiveUser(userId: string) {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        if (!user.isActive) {
            await this.signOutAll(user.id);
            throw new UnauthorizedException('User account is suspended');
        }

        return user;
    }

    private getBearerToken(headers: Headers): string | null {
        const authorization = headers.get('authorization');
        if (!authorization) {
            return null;
        }

        const [scheme, token] = authorization.split(' ');
        if (scheme?.toLowerCase() !== 'bearer' || !token) {
            return null;
        }

        return token.trim();
    }

    private mapAuthenticatedUser(user: AuthRuntimeUser): AuthenticatedUser {
        return {
            userId: user.id,
            email: user.email,
            username: user.name,
            provider: user.registrationProvider || 'local',
            emailVerified: user.emailVerified,
            isActive: user.isActive !== false,
            // L-05: propagate `isAnonymous` so controller-level guards
            // (e.g. claim-account is anonymous-only) can see it on `req.user`.
            // Without this, the post-bearer-auth user object lacks
            // `isAnonymous` and the L-05 check rejects legitimate anon-claim
            // attempts with 403 — surfaced by zero-friction E2E run
            // 26039862248. Better Auth's session.user shape may not include
            // the custom column, hence the defensive cast + `=== true`.
            isAnonymous: (user as AuthRuntimeUser & { isAnonymous?: boolean }).isAnonymous === true,
            avatar: user.image || null,
            iat: Math.floor(Date.now() / 1000),
            iss: 'auth-runtime',
            aud: 'ever-works-users',
        };
    }

    private mapAuthenticatedUserFromUser(user: User): AuthenticatedUser {
        return {
            userId: user.id,
            email: user.email,
            username: user.username,
            provider: user.registrationProvider || 'local',
            emailVerified: user.emailVerified,
            isActive: user.isActive !== false,
            // L-05: propagate `isAnonymous` — see `mapAuthenticatedUser`.
            isAnonymous: user.isAnonymous === true,
            avatar: user.avatar || null,
            iat: Math.floor(Date.now() / 1000),
            iss: 'auth-runtime',
            aud: 'ever-works-users',
        };
    }

    private getSessionRepository() {
        return this.dataSource.getRepository(AuthSession);
    }

    // H-01 (sessions): primary lookup is sha256(submitted token). Raw
    // bearer is hashed by the caller (`getBearerToken` → `hashSessionToken`)
    // before it touches the DB.
    //
    // Fallback path: Better Auth's signInEmail / signUpEmail / OAuth flows
    // create sessions through Better Auth's own adapter, which writes the
    // raw token to the legacy `token` column WITHOUT populating `tokenHash`.
    // Those sessions wouldn't match the tokenHash lookup, so every
    // bearer-authenticated request from a freshly-issued session would 401.
    // When tokenHash lookup misses, fall back to plain-token lookup, then
    // migrate the row in place: write `tokenHash = sha256(token)` and null
    // out the plaintext `token` column. Over time every session converges
    // to the H-01 invariant (hash-only) on first use.
    private async findSessionRecord(token: string) {
        const tokenHash = hashSessionToken(token);
        let session = await this.getSessionRepository().findOne({ where: { tokenHash } });
        if (session) return session;

        session = await this.getSessionRepository().findOne({ where: { token } });
        if (session) {
            await this.getSessionRepository().update(session.id, { token: null, tokenHash });
            session.token = null;
            session.tokenHash = tokenHash;
        }
        return session;
    }

    private async deleteSessionRecord(token: string) {
        const tokenHash = hashSessionToken(token);
        // Same dual-path as `findSessionRecord` — sessions created via Better
        // Auth's adapter live under the plaintext column until first use.
        await this.getSessionRepository().delete({ tokenHash });
        await this.getSessionRepository().delete({ token });
    }

    // H-04 + H-01 (sessions): bind sessions to the requesting client at
    // creation. The raw token is returned to the caller (and only the caller)
    // as `access_token`; the row stores `tokenHash = sha256(raw)` and writes
    // `null` into the legacy plaintext column. The values forwarded as
    // `clientFingerprint` are recorded for forensics; enforcement on use is
    // a separate roadmap item.
    private async createSessionRecord(
        userId: string,
        clientFingerprint?: { ipAddress?: string | null; userAgent?: string | null },
    ): Promise<AuthSession & { rawToken: string }> {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        const rawToken = randomBytes(24).toString('base64url');

        const session = this.getSessionRepository().create({
            id: randomUUID(),
            userId,
            token: null,
            tokenHash: hashSessionToken(rawToken),
            expiresAt,
            ipAddress: clientFingerprint?.ipAddress ?? null,
            userAgent: clientFingerprint?.userAgent ?? null,
        });

        const saved = await this.getSessionRepository().save(session);
        // The raw token never lives in the DB — surface it to the caller
        // via a non-persistent extra property so `issueSession` can return
        // it as `access_token`. Callers must not pass this object through
        // to a `.save()` again.
        return Object.assign(saved, { rawToken });
    }

    // H-17 (rest): per-user lockout helpers. We deliberately resolve the
    // user by email (not by Better Auth's session.user.id) so we can apply
    // the lockout BEFORE handing off to `signInEmail` — otherwise Better
    // Auth's own credential check leaks timing information.

    private async findUserRowByEmail(email: string): Promise<User | null> {
        return this.userRepository.findByEmail(email);
    }

    private isCurrentlyLocked(user: User): boolean {
        return Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now());
    }

    private buildLockoutMessage(user: User): string {
        const remainingMs = (user.lockedUntil?.getTime() ?? 0) - Date.now();
        const remainingMin = Math.max(1, Math.ceil(remainingMs / 60_000));
        return `Account temporarily locked due to too many failed login attempts, try again in ${remainingMin} minutes`;
    }

    private async recordFailedLogin(user: User): Promise<void> {
        const threshold = getLockoutThreshold();
        // H-17 follow-up: a read-modify-write on `failedLoginAttempts` lets
        // two concurrent failed logins for the same email both observe the
        // same `N`, both write `N+1`, and silently drop one increment —
        // giving an attacker an extra try past the lockout threshold. Use
        // the repository's atomic increment so the COUNT side compiles
        // down to a single `UPDATE … SET col = col + 1 …`. The post-increment
        // `lockedUntil` set is still a write-after-increment; that's fine —
        // only the count needed to be race-free, and a slight overshoot of
        // `lockedUntil` updates is benign (worst case: the lock window is
        // re-extended twice in quick succession, which only hurts the
        // attacker).
        await this.userRepository.increment(user.id, 'failedLoginAttempts', 1);
        const refreshed = await this.userRepository.findById(user.id);
        const nextCount = refreshed?.failedLoginAttempts ?? (user.failedLoginAttempts ?? 0) + 1;
        if (nextCount >= threshold) {
            await this.userRepository.update(user.id, {
                lockedUntil: new Date(Date.now() + getLockoutDurationMs()),
            });
        }
    }

    private async resetLockoutState(userId: string): Promise<void> {
        await this.userRepository.update(userId, {
            failedLoginAttempts: 0,
            lockedUntil: null,
        });
    }

    // L-07 (rehash-on-login): re-hash the user's plaintext password at the
    // configured `BCRYPT_COST` and write it through both stores (the Better
    // Auth `account` row and the `users.password` mirror). Called
    // fire-and-forget from `signInEmail` — see the comment there.
    private async rehashCredentialPassword(userId: string, plaintext: string): Promise<void> {
        const cost = getBcryptCost();
        const newHash = await bcrypt.hash(plaintext, cost);
        await this.authSyncService.syncCredentialPassword(userId, newHash);
        await this.userRepository.update(userId, { password: newHash });
    }
}
