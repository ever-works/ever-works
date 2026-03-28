import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserRepository, OAuthTokenRepository } from '@ever-works/agent/database';
import { createBetterAuthInstance, BetterAuthInstance } from '../better-auth.config';

@Injectable()
export class BetterAuthService implements OnModuleInit {
    private auth: BetterAuthInstance;

    constructor(
        @InjectDataSource() private dataSource: DataSource,
        private readonly userRepository: UserRepository,
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    onModuleInit() {
        this.auth = createBetterAuthInstance({
            dataSource: this.dataSource,
            userRepository: this.userRepository,
            oauthTokenRepository: this.oauthTokenRepository,
            eventEmitter: this.eventEmitter,
        });
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
