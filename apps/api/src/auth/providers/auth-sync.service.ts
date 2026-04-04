import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuthAccount } from '@ever-works/agent/entities';

@Injectable()
export class AuthSyncService {
	constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

	async findCredentialAccount(userId: string) {
		return this.getRepository().findOne({
			where: {
				userId,
				providerId: 'credential'
			}
		});
	}

	async ensureCredentialAccount(userId: string, passwordHash: string) {
		const existingAccount = await this.findCredentialAccount(userId);
		if (existingAccount) {
			return existingAccount;
		}

		return this.getRepository().save(
			this.getRepository().create({
				id: randomUUID(),
				userId,
				providerId: 'credential',
				accountId: userId,
				password: passwordHash
			})
		);
	}

	async syncCredentialPassword(userId: string, passwordHash: string) {
		const existingAccount = await this.findCredentialAccount(userId);
		if (!existingAccount) {
			await this.ensureCredentialAccount(userId, passwordHash);
			return;
		}

		await this.getRepository().update(existingAccount.id, {
			password: passwordHash
		});
	}

	async getCredentialPasswordHash(userId: string): Promise<string | null> {
		const account = await this.findCredentialAccount(userId);
		return account?.password || null;
	}

	private getRepository() {
		return this.dataSource.getRepository(AuthAccount);
	}
}
