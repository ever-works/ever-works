import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GithubStrategy } from 'passport-github2';
import { AuthService } from '../services/auth.service';
import { AuthProviders } from '@src/config/constants';
import { GitHubScopePresets } from '../config/github-scopes.config';

@Injectable()
export class GithubAuthStrategy extends PassportStrategy(GithubStrategy, AuthProviders.GITHUB) {
    constructor(private authService: AuthService) {
        const callbackURL =
            process.env.GITHUB_CALLBACK_URL || 'http://localhost:3100/auth/github/callback';

        super({
            clientID: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
            callbackURL: callbackURL,
            scope: GitHubScopePresets.AGENT,
            passReqToCallback: true,
        });
    }

    async validate(req: any, accessToken: string, refreshToken: string, profile: any) {
        profile.accessToken = accessToken;
        const user = await this.authService.validateGithubUser(profile);
        return user;
    }
}
