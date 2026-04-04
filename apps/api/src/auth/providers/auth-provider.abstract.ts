import type { AuthenticatedUser, TokenResponse } from '../types/jwt.types';

export abstract class AuthProvider {
	abstract authenticate(headers: Headers): Promise<AuthenticatedUser | null>;

	abstract signInEmail(email: string, password: string, headers: Headers): Promise<TokenResponse>;

	abstract signUpEmail(
		name: string,
		email: string,
		password: string,
		headers: Headers
	): Promise<TokenResponse>;

	abstract issueSession(userId: string): Promise<TokenResponse>;

	abstract changePassword(
		currentPassword: string,
		newPassword: string,
		headers: Headers
	): Promise<void>;

	abstract setPassword(userId: string, newPassword: string): Promise<void>;

	abstract signOut(headers: Headers): Promise<void>;

	abstract signOutAll(userId: string): Promise<void>;
}
