import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CrmConfigService {
	constructor(private configService: ConfigService) {}

	get twentyCrmConfig() {
		return {
			apiUrl: this.configService.get<string>('TWENTY_CRM_BASE_URL'),
			apiKey: this.configService.get<string>('TWENTY_CRM_API_KEY'),
			workspaceId: this.configService.get<string>('TWENTY_CRM_WORKSPACE_ID'),
			timeout: this.configService.get<number>('TWENTY_CRM_TIMEOUT_MS', 30000),
			retryAttempts: this.configService.get<number>('TWENTY_CRM_MAX_RETRIES', 3),
			retryDelay: this.configService.get<number>('TWENTY_CRM_RETRY_DELAY_MS', 1000),
		};
	}

	get isEnabled() {
		return !!(
			this.twentyCrmConfig.apiUrl &&
			this.twentyCrmConfig.apiKey &&
			this.twentyCrmConfig.workspaceId
		);
	}

	validateConfig() {
		const config = this.twentyCrmConfig;
		const missing = [];

		if (!config.apiUrl) missing.push('TWENTY_CRM_BASE_URL');
		if (!config.apiKey) missing.push('TWENTY_CRM_API_KEY');
		if (!config.workspaceId) missing.push('TWENTY_CRM_WORKSPACE_ID');

		if (missing.length > 0) {
			throw new Error(`Missing required Twenty CRM configuration: ${missing.join(', ')}`);
		}

		return true;
	}
}
