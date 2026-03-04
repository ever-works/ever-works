import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiKeyRepository, RefreshTokenRepository } from '@ever-works/agent/database';
import { authConstants, jwtConstants } from '../../config/constants';

@Injectable()
export class TokenCleanupService {
    private readonly logger = new Logger(TokenCleanupService.name);

    constructor(
        private readonly refreshTokenRepository: RefreshTokenRepository,
        private readonly apiKeyRepository: ApiKeyRepository,
    ) {}

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async handleTokenCleanup() {
        // Skip cleanup if token expiration is disabled
        if (jwtConstants.isTokenExpirationDisabled()) {
            this.logger.debug('Token cleanup skipped - expiration is disabled');
            return;
        }

        this.logger.log('Starting refresh token cleanup');

        try {
            // Delete expired tokens
            const expiredCount = await this.refreshTokenRepository.deleteExpiredTokens();
            this.logger.log(`Deleted ${expiredCount} expired refresh tokens`);

            // Delete revoked tokens older than configured days
            const daysAgo = new Date();
            daysAgo.setDate(daysAgo.getDate() - authConstants.refreshTokenCleanupDays);

            const revokedCount =
                await this.refreshTokenRepository.deleteRevokedTokensOlderThan(daysAgo);
            this.logger.log(`Deleted ${revokedCount} old revoked refresh tokens`);

            this.logger.log('Refresh token cleanup completed');

            // Clean up expired API keys
            const expiredApiKeys = await this.apiKeyRepository.deleteExpiredKeys();
            if (expiredApiKeys > 0) {
                this.logger.log(`Deleted ${expiredApiKeys} expired API keys`);
            }
        } catch (error) {
            this.logger.error('Error during token cleanup', error);
        }
    }
}
