export interface AuthRuntimeUser {
    id: string;
    email: string;
    emailVerified: boolean;
    name: string;
    image?: string | null;
    registrationProvider?: string | null;
    isActive?: boolean | null;
}

export interface AuthRuntimeContext {
    internalAdapter: {
        createSession(
            userId: string,
            disableRememberMe?: boolean,
        ): Promise<{ token: string } | null>;
        findSession(token: string): Promise<{
            session: { token: string; userId: string; expiresAt: Date };
            user: AuthRuntimeUser;
        } | null>;
        deleteSession(token: string): Promise<void>;
        deleteSessions(userId: string): Promise<void>;
        findAccounts(
            userId: string,
        ): Promise<
            Array<{ id: string; providerId: string; accountId: string; password?: string | null }>
        >;
        createAccount(account: {
            userId: string;
            providerId: string;
            accountId: string;
            password: string;
        }): Promise<unknown>;
        updatePassword(userId: string, password: string): Promise<unknown>;
    };
    password: {
        hash(password: string): Promise<string>;
    };
}

/**
 * APW-12 (Ever ID, plan §5.4) — which connected identity opened a session, and
 * the provider's session id (`sid`) when it sent one. Passed only by the Ever ID
 * sign-in path; every other caller of `issueSession` passes nothing and gets the
 * row it always got.
 */
export interface SessionOrigin {
    externalIdentityId: string;
    externalSid?: string | null;
}
