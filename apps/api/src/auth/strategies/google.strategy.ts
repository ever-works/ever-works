import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { AuthService } from '../services/auth.service';
import { AuthProviders, config } from '@src/config/constants';

@Injectable()
export class GoogleAuthStrategy extends PassportStrategy(GoogleStrategy, AuthProviders.GOOGLE) {
    constructor(private authService: AuthService) {
        super({
            clientID: config.google.clientId(),
            clientSecret: config.google.clientSecret(),
            callbackURL: config.google.callbackUrl(),
            scope: ['email', 'profile'],
            passReqToCallback: true,
        });
    }

    async validate(req: any, accessToken: string, refreshToken: string, profile: any) {
        const user = await this.authService.validateGoogleUser(profile);
        return user;
    }
}
