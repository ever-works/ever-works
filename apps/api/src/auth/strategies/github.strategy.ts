import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GithubStrategy } from 'passport-github2';
import { AuthService } from '../services/auth.service';
import { AuthProvider, config } from '../../config/constants';
import { GITHUB_SCOPES } from '../config/github-scopes.config';

@Injectable()
export class GithubAuthStrategy extends PassportStrategy(GithubStrategy, AuthProvider.GITHUB) {
    constructor(private authService: AuthService) {
        super({
            clientID: config.github.clientId() || 'placeholder',
            clientSecret: config.github.clientSecret() || 'placeholder',
            callbackURL: config.github.callbackUrl(),
            scope: GITHUB_SCOPES,
            passReqToCallback: true,
        });
    }

    async validate(req: any, accessToken: string, refreshToken: string, profile: any) {
        profile.accessToken = accessToken;
        const user = await this.authService.validateGithubUser(accessToken, refreshToken, profile);
        return user;
    }
}
