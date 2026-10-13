# Streamer API QA Framework

An evidence-based, **read-only** automation framework and interactive dashboard for two endpoints:

- `GET http://15.252.197.75:8000/api/v1/streamers`
- `GET http://15.252.197.75:8000/api/v1/streamers/{streamer_id}`

Expected results come only from two places:

- the live Swagger/OpenAPI contract (`/docs`, `/openapi.json`) and its documentation text;
- the real **MariaDB `streamer_api`** database, reached read-only through an SSH tunnel.

When those sources do not establish the expected behaviour, the case is marked **Needs Validation**. Such cases are never executed as pass/fail tests.

## Requirements

- Node.js 20 or newer (verified on Node 24.15.0).
- `npm install` once, for `mysql2` (MariaDB driver) and `ssh2` (SSH tunnel).
- Network access to `http://15.252.197.75:8000` and SSH access to the API host.
- Database credentials, supplied in one of two ways:
  - **Point to an existing file (current setup).** `api-qa-framework/.env` contains only one line, `DB_ENV_FILE=C:\Users\usre\automation test\.env`. The framework reads only the `DB_*` and `SSH_*` keys from that file. Their values are never copied, logged or shown.
  - **Put the keys here instead.** Copy the `DB_*` / `SSH_*` keys listed in `.env.example` into `api-qa-framework/.env`.

## Run

```bash
cd api-qa-framework
npm install
npm start
```

Open http://127.0.0.1:4310. The dashboard binds to localhost only.

The rate limit is capped at 2 operations per second, shared by API requests and DB queries. Retries are capped at 3. These caps apply whatever the configuration says.

## Use

1. **API Information** (top, collapsible): live Swagger contract details, MariaDB tables, columns, keys, and API↔DB relationships.
2. **Test Case Review**: 57 generated cases (45 executable, 12 Needs Validation). Every case starts as *Pending Review*.
   - Filter, search and sort the table.
   - Expand a row to see its full details.
   - Approve or reject per row, for the selected rows, or for every row matching the current filters. A reviewer comment is optional.
3. **Start Automation**: only approved, executable cases run. A second start while a run is active is refused.
4. **Stop Run**: no new cases or retries start. In-flight operations finish and are recorded.
5. **Live Execution Logs**: API requests, DB queries, assertions, retries and results as they happen.
6. **Execution Summary** tabs: Passed, Failed, Blocked, Needs Validation (with *Observe now*), Bugs and Defects, and Execution Report (downloadable as JSON).
7. **Framework Working Steps** (header link): how the framework works, with live evidence.

## Test

```bash
npm test
```

Unit tests cover the framework's own logic: the rate limiter under concurrency, the GET-only client, refusal of non-read-only SQL, redaction and masking, the schema validator, type-aware API↔DB comparison, and engine retries, classification and stop. They use local fixtures only and never touch the real API or database.

## Files

| Path | Purpose |
|---|---|
| `src/discovery.js` | Swagger contract, service, and MariaDB schema discovery (`information_schema`) |
| `src/db.js` | Read-only MariaDB access through an SSH tunnel; every query goes through the shared limiter |
| `src/catalog.js` | Test cases: evidence, expected result, assertion logic, and a `run` or `observe` function |
| `src/context.js` | Per-attempt HTTP/SQL evidence, assertions, and reference data |
| `src/engine.js` | Execution, retries, stop, classification, defects |
| `src/rateLimiter.js` | Single shared limiter for HTTP requests and DB queries (≤ 2 operations in any 1 s window) |
| `src/httpClient.js` | GET-only HTTP client, header redaction, PII masking |
| `src/store.js` | Approvals and run records in `data/` (git-ignored) |
| `src/server.js` | Dashboard server, JSON API, Server-Sent Events |
| `public/` | Dashboard (`index.html`, `app.js`, `styles.css`) and `working-steps.html` |

## Known limitations

See the dashboard's *Framework Working Steps → 7.10 Limitations*. In short:

- API↔DB comparisons prove consistency, not business correctness.
- The Swagger text says the data is in SQLite, but the connected database is MariaDB.
- The `users` table (it holds credentials) is never read.
- Write operations are not authorised, so they are not tested.
- No response-time threshold or severity/priority policy was supplied.
