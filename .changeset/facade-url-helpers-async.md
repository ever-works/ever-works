---
'@ever-works/plugin': minor
---

**Type change for code that implements or calls the host facade contracts.** `IGitFacade.getCloneUrl`, `getWebUrl`, `getLocalDir` and `getRawFileUrl`, and `IOAuthFacade.getAuthorizationUrl`, now return `Promise<string>` instead of `string`. Callers must `await` them, and an implementation must return a Promise. The host registers disk plugins, built-in ones included by default, as lazy proxies that stay unloaded until first use, so the facade has to load the provider before it can answer. Without the change these methods handed back a Promise typed as a string.

Plugins are not affected. The methods a plugin implements, `IGitProviderPlugin.getCloneUrl` / `getWebUrl` / `getLocalDir` / `getRawFileUrl` and `IOAuthPlugin.getAuthorizationUrl`, stay synchronous, and no plugin context hands out these facades. This ships as a minor, not a major, because a major would put every published plugin's `^1.x` SDK peer range out of date for a change no plugin can see.
