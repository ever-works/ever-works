import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GithubStrategy } from 'passport-github2';
import { GitHubScopePresets } from '../config/github-scopes.config';
import { config } from '../../config/constants';

/**
 * GitHub strategy specifically for connecting accounts (not login)
 */
@Injectable()
export class GithubConnectStrategy extends PassportStrategy(GithubStrategy, 'github-connect') {
    constructor() {
        super({
            clientID: config.github.clientId(),
            clientSecret: config.github.clientSecret(),
            callbackURL: config.github.connectCallbackUrl(),
            scope: GitHubScopePresets.AGENT,
            passReqToCallback: true,
        });
    }

    async validate(req: any, accessToken: string, refreshToken: string, profile: any) {
        // Store the OAuth data in the request for the controller to handle
        req.oauthData = {
            accessToken,
            refreshToken,
            profile,
        };

        // Return the authenticated user from the JWT
        return req.user;
    }
}
