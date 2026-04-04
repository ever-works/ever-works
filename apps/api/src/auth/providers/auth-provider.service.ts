import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { UserRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser, TokenResponse } from '../types/jwt.types';
import { AUTH_RUNTIME_INSTANCE } from './auth-provider.constants';
import { AuthProvider } from './auth-provider.abstract';
import { createAuthRuntimeInstance } from './auth-runtime.instance';
import type { AuthRuntimeContext, AuthRuntimeUser } from './auth-provider.types';
import { AuthSyncService } from './auth-sync.service';

@Injectable()
export class AuthProviderService extends AuthProvider {
	constructor(
		@Inject(AUTH_RUNTIME_INSTANCE)
		private readonly auth: ReturnType<typeof createAuthRuntimeInstance>,
		private readonly userRepository: UserRepository,
		private readonly authSyncService: AuthSyncService
	) {
		super();
	}

	async authenticate(headers: Headers): Promise<AuthenticatedUser | null> {
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
		const existingUser = await this.userRepository.findByEmail(email);
		if (existingUser?.password) {
			await this.authSyncService.ensureCredentialAccount(existingUser.id, existingUser.password);
		}

		const result = await this.auth.api.signInEmail({
			headers,
			body: {
				email,
				password,
				rememberMe: true
			}
		});

		const user = await this.assertActiveUser(result.user.id);
		const passwordHash = await this.authSyncService.getCredentialPasswordHash(user.id);
		if (passwordHash) {
			await this.userRepository.update(user.id, {
				password: passwordHash,
				lastLoginAt: new Date(),
				registrationProvider: 'local'
			});
		}

		return this.toTokenResponse(result.token, result.user as AuthRuntimeUser);
	}

	async signUpEmail(
		name: string,
		email: string,
		password: string,
		headers: Headers
	): Promise<TokenResponse> {
		const result = await this.auth.api.signUpEmail({
			headers,
			body: {
				name,
				email,
				password,
				rememberMe: true
			}
		});

		const passwordHash = await this.authSyncService.getCredentialPasswordHash(result.user.id);
		if (passwordHash) {
			await this.userRepository.update(result.user.id, {
				password: passwordHash,
				registrationProvider: 'local',
				isActive: true
			});
		}

		return this.toTokenResponse(result.token || '', result.user as AuthRuntimeUser);
	}

	async issueSession(userId: string): Promise<TokenResponse> {
		const user = await this.assertActiveUser(userId);
		const context = await this.getContext();
		const session = await context.internalAdapter.createSession(user.id);

		if (!session) {
			throw new UnauthorizedException('Failed to create session');
		}

		return {
			access_token: session.token,
			user: {
				id: user.id,
				email: user.email,
				username: user.username
			}
		};
	}

	async changePassword(
		currentPassword: string,
		newPassword: string,
		headers: Headers
	): Promise<void> {
		const session = await this.auth.api.getSession({ headers });
		await this.auth.api.changePassword({
			headers,
			body: {
				currentPassword,
				newPassword,
				revokeOtherSessions: true
			}
		});

		if (session?.user?.id) {
			const passwordHash = await this.authSyncService.getCredentialPasswordHash(session.user.id);
			if (passwordHash) {
				await this.userRepository.update(session.user.id, {
					password: passwordHash
				});
			}
		}
	}

	async setPassword(userId: string, newPassword: string): Promise<void> {
		const context = await this.getContext();
		const passwordHash = await context.password.hash(newPassword);
		const accounts = await context.internalAdapter.findAccounts(userId);
		const credentialAccount = accounts.find((account) => account.providerId === 'credential');

		if (!credentialAccount) {
			await context.internalAdapter.createAccount({
				userId,
				providerId: 'credential',
				accountId: userId,
				password: passwordHash
			});
			const createdPasswordHash = await this.authSyncService.getCredentialPasswordHash(userId);
			if (createdPasswordHash) {
				await this.userRepository.update(userId, {
					password: createdPasswordHash
				});
			}
			return;
		}

		await context.internalAdapter.updatePassword(userId, passwordHash);
		await this.userRepository.update(userId, {
			password: passwordHash
		});
	}

	async signOut(headers: Headers): Promise<void> {
		await this.auth.api.signOut({ headers });
	}

	async signOutAll(userId: string): Promise<void> {
		const context = await this.getContext();
		await context.internalAdapter.deleteSessions(userId);
	}

	private async getContext(): Promise<AuthRuntimeContext> {
		return (await this.auth.$context) as AuthRuntimeContext;
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

	private toTokenResponse(token: string, user: AuthRuntimeUser): TokenResponse {
		return {
			access_token: token,
			user: {
				id: user.id,
				email: user.email,
				username: user.name
			}
		};
	}

	private mapAuthenticatedUser(user: AuthRuntimeUser): AuthenticatedUser {
		return {
			userId: user.id,
			email: user.email,
			username: user.name,
			provider: user.registrationProvider || 'local',
			emailVerified: user.emailVerified,
			isActive: user.isActive !== false,
			avatar: user.image || null,
			iat: Math.floor(Date.now() / 1000),
			iss: 'auth-runtime',
			aud: 'ever-works-users'
		};
	}
}
