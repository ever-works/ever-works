// Public surface of the Shared view: the owner-side lifecycle, the token
// helpers, the publish filters (the security boundary) and the live board
// projection a share link reads.
export * from './shared-views.module';
export * from './shared-view.service';
export * from './shared-view.repository';
export * from './shared-view-projection.service';
export * from './shared-view-token';
export * from './publish-filter';
export * from './publishable-activity';
export {
    SharedView,
    sharedViewDefaults,
    type SharedViewTokenEnvelope,
} from '../entities/shared-view.entity';
