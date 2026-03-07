import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class ApiKeyGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request: { headers?: { authorization?: string } } = context.switchToHttp().getRequest();
		const authHeader = request.headers?.authorization;
		const apiKey = process.env.EVER_WORKS_API_KEY;

		if (!apiKey || !authHeader || authHeader !== `Bearer ${apiKey}`) {
			throw new UnauthorizedException();
		}

		return true;
	}
}
