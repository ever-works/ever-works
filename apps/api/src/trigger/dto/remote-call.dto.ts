import { IsString, IsObject } from 'class-validator';

export class RemoteCallDto {
    @IsString()
    name: string;

    @IsString()
    method: string;

    @IsObject()
    args: { json: unknown; meta?: unknown };
}
