import { Injectable } from '@nestjs/common';
import { config } from '../../config/constants';

@Injectable()
export class GitHubAppService {
    getConfiguration() {
        return {
            appId: config.githubApp.appId(),
            clientId: config.githubApp.clientId(),
            slug: config.githubApp.slug(),
            setupUrl: config.githubApp.setupUrl(),
        };
    }
}
