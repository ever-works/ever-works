import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { LocalStrategy } from './local.strategy';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { GithubAuthStrategy } from './github.strategy';
import { GoogleAuthStrategy } from './google.strategy';
import { DatabaseModule, UserRepository } from '@packages/agent/database';
import { jwtConstants } from '@src/config/constants';

@Module({
    imports: [
        PassportModule,
        DatabaseModule,
        JwtModule.registerAsync({
            useFactory: () => ({
                secret: jwtConstants.secret(),
                signOptions: { expiresIn: '15m' },
            }),
        }),
    ],
    providers: [
        AuthService,
        LocalStrategy,
        JwtStrategy,
        GithubAuthStrategy,
        GoogleAuthStrategy,
        UserRepository,
    ],
    controllers: [AuthController],
    exports: [AuthService],
})
export class AuthModule {}
