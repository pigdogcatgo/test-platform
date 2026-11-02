# MATHCOUNTS Test Platform

## What it supports

- Teacher, student, and administrator accounts, with teacher-managed student rosters and student histories.
- A shared searchable problem bank grouped by contest year and level, with separate year, level, round, and shared Elo details. Teachers can choose any bank problem for Sprint tests; Target tests use exactly eight problems.
- Timed Sprint and Target tests, answer grading, student rating updates, teacher analytics, and answer/solution release controls.

Teacher signup is public by default for this relaunch. Teachers can manage their students and tests, and choose from the shared problem bank; contest year and level determine the bank's groups. Only administrators can add problems, create catalog folders, or upload problem images. Student submissions from all classes contribute to each problem's shared Elo. Source details are shown in teacher problem selection, but source round does not limit whether a problem can be used in Sprint or Target.

## Run locally

Requirements: Node.js 20 or newer, npm, and Docker Desktop (or Docker Engine with Compose).

1. Configure a local-only PostgreSQL password for Docker Compose:

   ```sh
   cp .env.example .env
   openssl rand -hex 24
   ```

   Paste the generated value after `POSTGRES_PASSWORD=` in the root `.env` file.

2. Start the local PostgreSQL database:

   ```sh
   npm run db:up
   ```

3. In `backend/`, copy `.env.example` to `.env`, replace the database password with the value from the root `.env`, and replace `JWT_SECRET` with a private random value:

   ```sh
   cp backend/.env.example backend/.env
   openssl rand -base64 48
   ```

   Paste the generated JWT value into `backend/.env`. The API database URL should use the same local password as Docker Compose.

4. Install dependencies once in each app folder, then start the API and frontend in separate terminals:

   ```sh
   cd backend && npm install && npm run dev
   ```

   ```sh
   cd frontend && npm install && npm run dev
   ```

   Vite forwards `/api` and `/uploads` requests to `http://localhost:3001`. Requests use the frontend's own origin unless `VITE_API_URL` is set. On the first development seed, the API prints random local-only passwords for the sample admin, teacher, and students. Store them privately; each student account shares one generated password.

Stop PostgreSQL with `npm run db:down`. This keeps its named volume and data. To permanently erase the local database, run `docker compose down -v` from this folder.

## Configuration

The API reads its environment from `backend/.env`. See [backend/.env.example](backend/.env.example). The frontend reads `frontend/.env`; see [frontend/.env.example](frontend/.env.example). For a separately hosted API, set `VITE_API_URL` to its origin. For a same-origin deployment, leave it empty and configure the web server or platform to route `/api` and `/uploads` to the backend.

`JWT_SECRET` is required in every environment and must be at least 32 characters, randomly generated, and not a placeholder. Do not commit `.env` files or share the value.

The API allows `http://localhost:5173` and `http://127.0.0.1:5173` in development. Production allows no cross-origin browser requests unless `CORS_ORIGINS` is set to a comma-separated list of exact trusted origins. Same-origin hosting needs no CORS entry. The API sends `X-Content-Type-Options: nosniff`; uploaded images are checked against their declared MIME type and file signature.

Teacher self-signup is open by default in every environment; set `ENABLE_TEACHER_SIGNUP=false` to disable it. Signup requires a password of at least 12 characters and at most 72 UTF-8 bytes (bcrypt's input limit). Signup is limited to 5 attempts per IP per 15 minutes; login is limited to 20 per IP per 15 minutes. Signup and login counters remain bounded in-memory per API process.

Image files are limited to 5 MB each. Administrators may store up to 50 MB each and 200 MB total of aggregate image data in the database, measured from the stored `uploads.data` values. These quotas are checked under database advisory locks before each image insert. Stale unreferenced uploads are garbage-collected in a separate committed transaction before quota checks, so a rejected upload does not roll back cleanup. Unreferenced image rows are removed when problems are deleted; other unreferenced rows remain counted for up to 24 hours to allow an uploaded image to be attached to a problem. For a generic reverse proxy, set `TRUST_PROXY` to the exact number of trusted proxy hops so IP throttles use the client address; leave it unset for direct connections. The Render Blueprint uses Cloudflare's `CF-Connecting-IP` header; missing or invalid values share one conservative rate-limit key and never fall back to the socket address.

## Production first administrator

Set `NODE_ENV=production`, `DATABASE_URL`, and a private random `JWT_SECRET` of at least 32 characters in the production API environment. Production startup never inserts demo accounts or fictional sample content. It idempotently adds five licensed, attributed problems from the 2022 MATHCOUNTS National Sprint Round to the shared problem bank; the owner attestation and source references are recorded in [PROBLEM_CONTENT_RIGHTS.md](backend/PROBLEM_CONTENT_RIGHTS.md). For a brand-new production database, set both `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` in the API's private environment settings to create one administrator. Use a unique username and a strong password of at least 12 characters. Remove these bootstrap variables after the first administrator is created. If users already exist, startup does not add another administrator. If `NODE_ENV` is unset or has another value, demo seeding is skipped; only explicit `NODE_ENV=development` enables demo accounts and sample content.

For relaunch, use a new empty production database and leave the old database untouched; the old accounts and data are not needed for that fresh start.

## Free Render deployment

The included [Render Blueprint](render.yaml) deploys the API and built frontend together on one free web service, so browser requests stay same-origin. Create a new empty PostgreSQL database with a provider that does not expire it, then create a Blueprint in Render from this repository and supply `DATABASE_URL`, `BOOTSTRAP_ADMIN_USERNAME`, and `BOOTSTRAP_ADMIN_PASSWORD` when prompted. Render generates `JWT_SECRET`. If using Supabase, copy its **Shared Pooler, Session mode** connection string from the Connect dialog; Render services are IPv4-only, while Supabase direct connection strings use IPv6 by default. After the first successful deploy and admin creation, remove the two bootstrap variables from the Render service settings. Teacher signup is open by default as requested; set `ENABLE_TEACHER_SIGNUP=false` to turn it off. See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres) for the correct connection mode.

The free Render API sleeps after 15 minutes without traffic, and its local filesystem is ephemeral; this app stores uploaded images in Postgres. The frontend and API share the service, while the database stays outside Render so it will not be subject to Render's 30-day free-Postgres expiration. The Render free service can take about a minute to wake after idle. Supabase Free is one $0 database option (500 MB); it pauses projects after a week of low activity but retains their data. See [Render free-service limits](https://render.com/docs/free) and [Supabase's free-project pause policy](https://supabase.com/kb/faqs/platform/free-project-pausing).

For Supabase, set `DATABASE_SSL_CA_BASE64` before the first deploy: download `prod-ca-2021.crt` from the authenticated project's Database Settings, encode it locally with `base64 -i prod-ca-2021.crt | tr -d '\n'`, then add the result in Render's environment settings. The Render Blueprint declares this variable as `sync: false`. The certificate is a public trust anchor; preserve its integrity and update the value if Supabase rotates its database root certificate. Production PostgreSQL TLS keeps `rejectUnauthorized: true`; the supplied PEM is used for certificate-chain and hostname verification. The application strips SSL-related query parameters from the production `DATABASE_URL` so they cannot weaken or override that explicit TLS configuration. It does not log the CA or its encoded value.

## OPLET partnership prototype preview

The separate [Render preview Blueprint](render-oplet-demo.yaml) is for a fictional partnership demo. It runs in production mode with its own `DEMO_DATABASE_URL`, JWT secret, and teacher/student credentials; it never falls back to `DATABASE_URL`. Create a **new empty Supabase project** for the preview. Do not reuse the production database URL or copy production rows into it. The preview startup refuses a database that contains existing application data.

1. Create a separate Supabase Free project for the demo. Copy its PostgreSQL connection string in **Shared Pooler, Session mode** and retrieve the project CA certificate as described above.
2. In Render, create a Blueprint from this repository on the `codex/oplet-partnership-prototype` branch and select `render-oplet-demo.yaml`. Enter the new database connection string as `DEMO_DATABASE_URL` and the new project's CA as `DATABASE_SSL_CA_BASE64`. Never provide the production `DATABASE_URL` to this service.
3. Render generates the demo JWT secret. The public fictional logins are `demo-teacher` / `teacher-preview-26` and `demo-student` / `student-preview-26`; the login page has buttons to fill them. These passwords are intentionally public for this isolated demo and must never be reused elsewhere. Five fictional student accounts share the student password for the interactive demo and synthetic aggregate sample.

The preview shows a persistent shared-state banner. The sample student can take each assignment once; later reviewers can use the teacher login to create fresh Sprint or Target tests. Previous submissions and ELO changes remain in the isolated demo database. The demo reports only aggregate trends and does not expose student rosters or individual profiles. Signup, catalog edits, uploads, PDF imports, Gemini processing, and administrator routes are disabled. The catalog questions and aggregate results are fictional, and the interface describes OPLET as a proposed concept rather than a live integration or partnership.

This service is intended for a limited demonstration, not production use. A Render Free web service can sleep after 15 minutes idle, and Supabase Free projects may pause after a week of low activity. See [Render Free service limits](https://render.com/docs/free) and [Supabase Free project limits](https://supabase.com/docs/guides/platform/billing-on-supabase) before sharing a demo date.
