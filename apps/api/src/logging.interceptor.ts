import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { config } from './config/constants';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    private logger = new Logger('HTTP');

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        if (!config.debug()) {
            return next.handle();
        }

        const now = Date.now();
        const request = context.switchToHttp().getRequest();
        const { method, originalUrl } = request;

        this.logger.log(`Incoming Request: ${method} ${originalUrl}`);

        return next.handle().pipe(
            tap(() => {
                const response = context.switchToHttp().getResponse();
                const { statusCode } = response;
                const delay = Date.now() - now;

                this.logger.log(
                    `Outgoing Response: ${method} ${originalUrl} ${statusCode} - ${delay}ms`,
                );
            }),
        );
    }
}
