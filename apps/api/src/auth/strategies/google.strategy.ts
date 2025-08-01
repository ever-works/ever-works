import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { AuthService } from '../services/auth.service';
import { AuthProviders } from '@src/config/constants';

@Injectable()
export class GoogleAuthStrategy extends PassportStrategy(GoogleStrategy, AuthProviders.GOOGLE) {
    constructor(private authService: AuthService) {
        const callbackURL =
            process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3100/auth/google/callback';

        super({
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: callbackURL,
            scope: ['email', 'profile'],
            passReqToCallback: true,
        });
    }

    async validate(req: any, accessToken: string, refreshToken: string, profile: any) {
        const user = await this.authService.validateGoogleUser(profile);
        return user;
    }
}
