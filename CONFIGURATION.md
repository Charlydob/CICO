# Configuration

Copy `.env.example` to `.env` and fill production secrets locally on the server.

```bash
cp .env.example .env
```

Important variables:

- `APP_DOMAIN`: production domain, for example `hotelapp.charlydob.com`.
- `APP_ORIGIN`: full origin, for example `https://hotelapp.charlydob.com`.
- `DATABASE_URL`: PostgreSQL connection used by Prisma.
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`: database container settings.
- `SESSION_SECRET`: long random session secret reserved for session hardening.
- `BOOTSTRAP_ADMIN_EMAIL`: first platform admin email.
- `BOOTSTRAP_ADMIN_PASSWORD`: first platform admin password. Used only when no `platform_admin` exists.
- `DATA_DIR`: persistent backend data directory inside the backend container.
- `EVIDENCE_DIR`: persistent evidence directory inside the backend container.
- `PUBLIC_CHECKOUT_RATE_LIMIT`: checkout QR rate limit.
- `CHECKOUT_COOLDOWN_SECONDS`: duplicate checkout cooldown.

Local development:

```bash
npm install
npx prisma generate
npm run backend
npm run dev
```

In development, Vite proxies `/api` to `http://127.0.0.1:3001`. In production, the frontend calls `/api/...` on the same origin.

Production:

```bash
docker compose up -d --build
```

See [docs/HETZNER_DEPLOYMENT.md](docs/HETZNER_DEPLOYMENT.md) for the full server runbook.

## Hookbox check-in and display design
See [Hookbox implementation and lab setup](docs/HOOKBOX_CHECKIN.md) and [validation](docs/HOOKBOX_VALIDATION.md). The check-in build is MOCK; 25-channel physical check-in is not commissioned. Set HOOKBOX_PROVIDERS_JSON on the backend; the provided Compose files pass it through. No deployment has been performed.
