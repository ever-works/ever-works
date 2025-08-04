import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GithubStrategy } from 'passport-github2';
import { AuthService } from '../services/auth.service';
import { AuthProviders, config } from '../../config/constants';
import { GitHubScopePresets } from '../config/github-scopes.config';

@Injectable()
export class GithubAuthStrategy extends PassportStrategy(GithubStrategy, AuthProviders.GITHUB) {
    constructor(private authService: AuthService) {
        super({
            clientID: config.github.clientId() || 'placeholder',
            clientSecret: config.github.clientSecret() || 'placeholder',
            callbackURL: config.github.callbackUrl(),
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
