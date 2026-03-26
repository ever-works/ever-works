import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createBetterAuthInstance, BetterAuthInstance } from '../better-auth.config';

@Injectable()
export class BetterAuthService implements OnModuleInit {
	private auth: BetterAuthInstance;

	constructor(@InjectDataSource() private dataSource: DataSource) {}

	onModuleInit() {
		this.auth = createBetterAuthInstance(this.dataSource);
	}

	get instance(): BetterAuthInstance {
		return this.auth;
	}

	get api() {
		return this.auth.api;
	}

	/**
	 * Handle an incoming HTTP request by delegating to BetterAuth's internal router.
	 */
	async handleRequest(request: Request): Promise<Response> {
		return this.auth.handler(request);
	}
}
