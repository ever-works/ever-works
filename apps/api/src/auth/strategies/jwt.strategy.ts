import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { jwtConstants } from '@src/config/constants';
import { JwtPayload, AuthenticatedUser } from '../types/jwt.types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: jwtConstants.isTokenExpirationDisabled(),
            secretOrKey: jwtConstants.secret(),
        });
    }

    async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
        return {
            userId: payload.sub,
            email: payload.email,
            username: payload.username,
            provider: payload.provider,
            emailVerified: payload.emailVerified,
            isActive: payload.isActive,
            avatar: payload.avatar,
            iat: payload.iat,
            iss: payload.iss,
            aud: payload.aud,
        };
    }
}
