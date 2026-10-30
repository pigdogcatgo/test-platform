# MATHCOUNTS Test Platform

## What it supports

- Teacher, student, and administrator accounts, with teacher-managed student rosters and student histories.
- A searchable problem bank with folders, topic tags, source information, and image diagrams.
- Timed Sprint and Target tests, answer grading, student rating updates, teacher analytics, and answer/solution release controls.
- PDF problem imports with answer-key parsing, optional Gemini-assisted extraction and verification, image-based crop review, and retry controls. Teachers can also create PDF-based tests with one shared, private student PDF and separate per-question answers and ratings.

Teacher signup is public by default for this relaunch. Teachers can then manage their own students, problems, folders, tags, tests, and imports; administrator-only features remain protected by role checks.

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

The API allows `http://localhost:5173` and `http://127.0.0.1:5173` in development. Production allows no cross-origin browser requests unless `CORS_ORIGINS` is set to a comma-separated list of exact trusted origins. Same-origin hosting needs no CORS entry. The API sends `X-Content-Type-Options: nosniff`; uploaded images and PDFs are checked against their declared MIME type and file signature.

Teacher self-signup is open by default in every environment; set `ENABLE_TEACHER_SIGNUP=false` to disable it. Signup requires a password of at least 12 characters and at most 72 UTF-8 bytes (bcrypt's input limit). Signup is limited to 5 attempts per IP per 15 minutes; login is limited to 20 per IP per 15 minutes. Authenticated PDF imports are limited to 3 starts per user per API process per hour and 12 starts total per hour across replicas using an atomic PostgreSQL counter. Missing files and uploads without the PDF signature are rejected before they consume the shared budget; the shared budget can still be used by PDFs rejected during later content validation. A per-process semaphore allows at most 2 concurrent PDF requests before the PDF body is buffered. Signup, login, and the per-user PDF counters remain bounded in-memory per API process.

Image files are limited to 5 MB each and PDFs to 15 MB and 60 pages each. Image-mode PDF imports refine at most 10 unique pages with Gemini; remaining pages keep their initial AI regions, with full-page rendering as the fallback when a region is missing. Teachers may store up to 50 MB each and 200 MB total of aggregate image data in the database, measured from the stored `uploads.data` values. These quotas are checked under database advisory locks before each image insert, including images produced by PDF imports. Stale unreferenced uploads are garbage-collected in a separate committed transaction before quota checks, so a rejected upload does not roll back cleanup. Unreferenced image rows are removed when problems are deleted or image-review sessions expire; other unreferenced rows remain counted for up to 24 hours to allow an uploaded image to be attached to a problem. Image review allows at most three Gemini retries per PDF session. For a generic reverse proxy, set `TRUST_PROXY` to the exact number of trusted proxy hops so IP throttles use the client address; leave it unset for direct connections. The Render Blueprint uses Cloudflare's `CF-Connecting-IP` header; missing or invalid values share one conservative rate-limit key and never fall back to the socket address.

PDF imports require the teacher to record the source and rights basis, confirm rights to store/process/share the material, provide a complete answer key, and review every extracted question and page. A final preview of the exact student-facing PDF must be approved before anything is saved. Student PDFs contain only approved question pages; original source PDFs remain private to the importing teacher. PDF storage has separate quotas of 50 MB per teacher and 200 MB total, counting both source and student-safe copies. Source PDFs are limited to 15 MB and 60 pages. AI processing is off unless the teacher opts in, and the import UI explains that the source PDF and answer key are sent to Google Gemini when enabled. Text-only PDFs can be processed locally. PDFs containing embedded images or without a meaningful text layer require their exact SHA-256 digest in `PDF_APPROVED_SCANNED_SHA256` before import; this includes image-based diagrams. MATHCOUNTS files are denied by default; the platform administrator must configure both written-permission details from the teacher and the exact file digest in `MATHCOUNTS_APPROVED_PDF_SHA256`. These comma-separated hash allowlists belong in the API's private environment settings and default to empty.

For a PDF-based test, select approved questions from one source document and enable **Shared PDF** when creating the test. The answer sheet and grading remain attached to each individual problem record. The browser requests the PDF through a private endpoint that checks the teacher or an assigned student's active test session; student test responses contain page mappings but never answer values. Regular tests continue to use the standard per-problem display.

## Production first administrator

Set `NODE_ENV=production`, `DATABASE_URL`, and a private random `JWT_SECRET` of at least 32 characters in the production API environment. Production startup never inserts the demo accounts or sample problems. For a brand-new production database, set both `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` in the API's private environment settings to create one administrator. Use a unique username and a strong password of at least 12 characters. Remove these bootstrap variables after the first administrator is created. If users already exist, startup does not add another administrator. If `NODE_ENV` is unset or has another value, demo seeding is skipped; only explicit `NODE_ENV=development` enables demo accounts and sample content.

For relaunch, use a new empty production database and leave the old database untouched; the old accounts and data are not needed for that fresh start.

## Free Render deployment

The included [Render Blueprint](render.yaml) deploys the API and built frontend together on one free web service, so browser requests stay same-origin. Create a new empty PostgreSQL database with a provider that does not expire it, then create a Blueprint in Render from this repository and supply `DATABASE_URL`, `BOOTSTRAP_ADMIN_USERNAME`, and `BOOTSTRAP_ADMIN_PASSWORD` when prompted. Render generates `JWT_SECRET`. If using Supabase, copy its **Shared Pooler, Session mode** connection string from the Connect dialog; Render services are IPv4-only, while Supabase direct connection strings use IPv6 by default. After the first successful deploy and admin creation, remove the two bootstrap variables from the Render service settings. Teacher signup is open by default as requested; set `ENABLE_TEACHER_SIGNUP=false` to turn it off. See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres) for the correct connection mode.

The free Render API sleeps after 15 minutes without traffic, and its local filesystem is ephemeral; this app stores uploaded images in Postgres. The frontend and API share the service, while the database stays outside Render so it will not be subject to Render's 30-day free-Postgres expiration. The Render free service can take about a minute to wake after idle. Supabase Free is one $0 database option (500 MB); it pauses projects after a week of low activity but retains their data. See [Render free-service limits](https://render.com/docs/free) and [Supabase's free-project pause policy](https://supabase.com/kb/faqs/platform/free-project-pausing).

For Supabase, set `DATABASE_SSL_CA_BASE64` before the first deploy: download `prod-ca-2021.crt` from the authenticated project's Database Settings, encode it locally with `base64 -i prod-ca-2021.crt | tr -d '\n'`, then add the result in Render's environment settings. The Render Blueprint declares this variable as `sync: false`. The certificate is a public trust anchor; preserve its integrity and update the value if Supabase rotates its database root certificate. Production PostgreSQL TLS keeps `rejectUnauthorized: true`; the supplied PEM is used for certificate-chain and hostname verification. The application strips SSL-related query parameters from the production `DATABASE_URL` so they cannot weaken or override that explicit TLS configuration. It does not log the CA or its encoded value.
