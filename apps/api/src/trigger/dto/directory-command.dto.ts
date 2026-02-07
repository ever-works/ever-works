import { Type } from 'class-transformer';
import { IsEnum, IsObject, IsOptional } from 'class-validator';
import { DirectoryCommandAction } from '@ever-works/agent/tasks';

export class DirectoryCommandDto {
    @IsEnum(DirectoryCommandAction)
    action: DirectoryCommandAction;

    @IsOptional()
    @IsObject()
    @Type(() => Object)
    payload?: Record<string, unknown>;
}
