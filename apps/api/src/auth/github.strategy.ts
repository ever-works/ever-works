import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GithubStrategy } from 'passport-github2';
import { AuthService } from './auth.service';

@Injectable()
export class GithubAuthStrategy extends PassportStrategy(GithubStrategy, 'github') {
    constructor(private authService: AuthService) {
        super({
            clientID: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
            callbackURL: process.env.GITHUB_CALLBACK_URL || 'http://localhost:3100/auth/github/callback',
            scope: ['user:email'],
            passReqToCallback: true,
        });
    }

    async validate(req: any, accessToken: string, refreshToken: string, profile: any) {
        profile.accessToken = accessToken;
        const user = await this.authService.validateGithubUser(profile);
        return user;
    }
}
