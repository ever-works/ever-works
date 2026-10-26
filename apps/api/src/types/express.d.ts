// A global augmentation inside a module (note the `export {}`), not an ambient
// module declaration. Written as a bare `declare module 'express-serve-static-core' { … }`
// in a script file, this file REPLACED the real module for the whole app, so
// `import type { Request, Response } from 'express'` resolved to empty
// interfaces (`res.status`, `res.setHeader` did not compile). The global
// `Express.Request` is what express-serve-static-core merges into its Request.
declare global {
    namespace Express {
        interface Request {
            rawBody?: string;
        }
    }
}

export {};
