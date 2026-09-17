# Fixture — `descriptor-hint` (detection step 5)

> DRAFT — the tree APW-13 creates as a fixture repository (plan §11.4). Expectation: `expectations.json#/cases/descriptor-hint`.

```
descriptor-hint/
├── Procfile               # web: node src/server.js
├── Dockerfile             # FROM node:20-alpine; EXPOSE 4000   (no CMD)
├── package.json           # express, bullmq, ioredis
├── src/
│   ├── server.js          # reads process.env.PORT, listens on it
│   └── queue.js           # new Queue('jobs', { connection: { url: process.env.REDIS_URL } })
└── .env.example           # REDIS_URL, PORT
```

## What matters here

- The `Procfile` is a **hint**: it wins step 5 and gives the entry command, but the port comes from `src/server.js`
  (`process.env.PORT`) and the image from `Dockerfile`, each citing its own file.
- The `bullmq`/`ioredis` client in `src/queue.js` is what infers **redis** — the inference cites that file, not the
  descriptor and not the docs.
- A descriptor-only route (a cron path written in a hosting descriptor but absent from the code) must produce **no**
  `cron` entry: this fixture is deliberately missing one, so a run that invents it fails the case.
- Because the repository has a Dockerfile, no overlay Dockerfile is written.
