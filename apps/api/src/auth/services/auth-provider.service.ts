import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserRepository, OAuthTokenRepository } from '@ever-works/agent/database';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { createAuthProviderInstance, AuthProviderInstance } from '../auth-provider.config';

@Injectable()
export class AuthProviderService implements OnModuleInit {
    private auth: AuthProviderInstance;

    constructor(
        @InjectDataSource() private dataSource: DataSource,
        private readonly userRepository: UserRepository,
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly activityLogService: ActivityLogService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    onModuleInit() {
        this.auth = createAuthProviderInstance({
            dataSource: this.dataSource,
            userRepository: this.userRepository,
            oauthTokenRepository: this.oauthTokenRepository,
            activityLogService: this.activityLogService,
            eventEmitter: this.eventEmitter,
        });
    }

    get instance(): AuthProviderInstance {
        return this.auth;
    }

    get api() {
        return this.auth.api;
    }

    /**
     * Handle an incoming HTTP request by delegating to the configured auth provider router.
     */
    async handleRequest(request: Request): Promise<Response> {
        return this.auth.handler(request);
    }
}
