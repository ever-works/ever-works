import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { AuthService } from '../services/auth.service';
import { AuthProvider, config } from '../../config/constants';

@Injectable()
export class GoogleAuthStrategy extends PassportStrategy(GoogleStrategy, AuthProvider.GOOGLE) {
    constructor(private authService: AuthService) {
        super({
            clientID: config.google.clientId() || 'placeholder',
            clientSecret: config.google.clientSecret() || 'placeholder',
            callbackURL: config.google.callbackUrl(),
            scope: ['email', 'profile'],
            passReqToCallback: true,
        });
    }

    async validate(req: any, accessToken: string, refreshToken: string, profile: any) {
        const user = await this.authService.validateGoogleUser(accessToken, refreshToken, profile);
        return user;
    }
}
