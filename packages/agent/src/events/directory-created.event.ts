import { Directory } from '@src/entities';
import { BaseEvent } from './base';

export class DirectoryCreatedEvent extends BaseEvent {
    static EVENT_NAME = 'directory.created';

    constructor(public readonly directory: Directory) {
        super();
    }
}
