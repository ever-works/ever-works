import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GithubStrategy } from 'passport-github2';
import { GitHubScopePresets } from '../config/github-scopes.config';

/**
 * GitHub strategy specifically for connecting accounts (not login)
 */
@Injectable()
export class GithubConnectStrategy extends PassportStrategy(GithubStrategy, 'github-connect') {
    constructor() {
        super({
            clientID: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
            callbackURL: process.env.GITHUB_CONNECT_CALLBACK_URL || 'http://localhost:3100/auth/connections/github/callback',
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