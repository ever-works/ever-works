import { IsString, IsArray } from 'class-validator';

export class RemoteCallDto {
    @IsString()
    name: string;

    @IsString()
    method: string;

    @IsArray()
    args: unknown[];
}
