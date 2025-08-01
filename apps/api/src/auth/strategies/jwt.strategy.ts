import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { jwtConstants } from '@src/config/constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: jwtConstants.isTokenExpirationDisabled(),
            secretOrKey: jwtConstants.secret(),
        });
    }

    async validate(payload: any) {
        return { userId: payload.sub, email: payload.email };
    }
}
