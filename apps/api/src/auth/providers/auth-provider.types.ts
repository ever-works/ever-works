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
			disableRememberMe?: boolean
		): Promise<{ token: string } | null>;
		deleteSessions(userId: string): Promise<void>;
		findAccounts(userId: string): Promise<
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
