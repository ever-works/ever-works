import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class ApiKeyGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request: { headers?: { authorization?: string } } = context.switchToHttp().getRequest();
		const authHeader = request.headers?.authorization;
		const apiKey = process.env.EVER_WORKS_API_KEY;

		if (!apiKey) {
			throw new UnauthorizedException();
		}

		const expected = `Bearer ${apiKey}`;
		if (typeof authHeader !== 'string' || authHeader.length === 0) {
			throw new UnauthorizedException();
		}

		// Constant-time comparison (H-08). Always run timingSafeEqual on an
		// equal-length buffer so the cost is uniform regardless of the
		// submitted header's length — a naive length-then-compare short-circuit
		// would let an attacker binary-search the expected length.
		const expectedBuf = Buffer.from(expected, 'utf8');
		const providedBuf = Buffer.from(authHeader, 'utf8');
		const lengthsMatch = expectedBuf.length === providedBuf.length;
		const comparisonBuf = lengthsMatch ? providedBuf : Buffer.alloc(expectedBuf.length);
		const bytesMatch = timingSafeEqual(expectedBuf, comparisonBuf);

		if (!lengthsMatch || !bytesMatch) {
			throw new UnauthorizedException();
		}

		return true;
	}
}
