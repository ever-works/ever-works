import { Directory } from '@src/entities';
import { BaseEvent } from './base';

export class DirectoryGenerationCompletedEvent extends BaseEvent {
    static EVENT_NAME = 'directory.generation.completed';

    constructor(public readonly directory: Directory) {
        super();
    }
}
