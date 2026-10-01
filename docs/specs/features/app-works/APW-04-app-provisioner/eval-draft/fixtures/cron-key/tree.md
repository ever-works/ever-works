# Fixture — `cron-key` (scheduled route + fixed-length key)

> DRAFT — the tree APW-13 creates as a fixture repository (plan §11.4). Expectation: `expectations.json#/cases/cron-key`.

```
cron-key/
├── Dockerfile             # FROM python:3.12-slim; EXPOSE 8000
├── requirements.txt       # fastapi, uvicorn, psycopg, croniter
├── .env.example           # DATABASE_URL, CRON_SECRET, CIPHER_KEY
├── app/
│   ├── main.py            # GET /healthz (db-touching), GET /livez-db-free (no db)
│   ├── cron.py            # GET /internal/reindex, checks the X-Cron-Secret header
│   └── crypto.py          # CIPHER_KEY must be exactly 32 characters; raises otherwise
└── render.yaml            # mentions /internal/listed-only-in-descriptor — NOT present in the code
```

## What matters here

- **Two cron candidates, one decision**: `/internal/reindex` exists in `app/cron.py` and becomes a `cron` entry with a
  generated `CRON_SECRET` and a negative smoke test (an unauthenticated call is refused).
  `/internal/listed-only-in-descriptor` appears **only** in `render.yaml` and must produce **no** entry at all.
- `CIPHER_KEY` is a secret whose shape the code constrains — exactly 32 characters — so the generator **and** a
  validation rule both encode that length (ACC-04-11).
- Liveness (`/livez-db-free`) never touches the database while readiness (`/healthz`) may (ACC-04-15).
- **postgres** is inferred from the `psycopg` client in `requirements.txt`, citing that file (ACC-04-12).
