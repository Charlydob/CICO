# Hetzner Deployment

HotelApp supports two deployment modes:

- Standalone installation: a new empty server where HotelApp creates its own PostgreSQL and public Caddy.
- Existing Hetzner server: the real `charlydob.com` server, where Caddy, PostgreSQL, Frigate, n8n, and other services already exist.

Production URL:

```text
https://hotelapp.charlydob.com
```

## Installation Standalone

Use this mode only for an empty server dedicated to HotelApp.

The default `docker-compose.yml` starts:

- PostgreSQL 16 for HotelApp.
- Backend on the internal Docker network.
- Frontend served by Caddy on public `80/443`.
- Caddy-managed HTTPS certificates.

Prepare Ubuntu:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
newgrp docker
```

Clone and configure:

```bash
git clone https://github.com/YOUR_ORG/ParkingDetector.git HotelApp
cd HotelApp
cp .env.example .env
nano .env
```

Required values:

```env
APP_DOMAIN=hotelapp.charlydob.com
APP_ORIGIN=https://hotelapp.charlydob.com
POSTGRES_PASSWORD=replace-with-a-long-secret
DATABASE_URL=postgresql://hotelapp:replace-with-a-long-secret@postgres:5432/hotelapp?schema=public
SESSION_SECRET=replace-with-a-long-random-secret
BOOTSTRAP_ADMIN_EMAIL=owner@example.com
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-long-initial-password
```

Start:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f backend
```

Database migrations run on backend startup with `prisma migrate deploy`.

## Existing Hetzner Server

Use this mode for the real Hetzner server that already runs the shared stack.

This mode uses:

- Host Caddy already installed on the server for public HTTPS.
- Existing PostgreSQL 16 container.
- Existing Docker network `charly-stack_default`.
- Existing Frigate container reachable as `http://frigate:5000`.

This mode does not start:

- A new PostgreSQL container.
- A public Caddy container on `80/443`.
- A new Frigate container.
- n8n, Bookshell, or any other existing service.

The HotelApp containers are attached to the external Docker network:

```text
charly-stack_default
```

Backend resolves PostgreSQL as:

```text
postgres:5432
```

Backend resolves Frigate as:

```text
http://frigate:5000
```

Clone and configure:

```bash
git clone https://github.com/YOUR_ORG/ParkingDetector.git HotelApp
cd HotelApp
cp .env.hetzner.example .env
nano .env
```

Required values:

```env
DATABASE_URL=postgresql://hotelapp_app:replace-with-real-password@postgres:5432/hotelapp?schema=public
SESSION_SECRET=replace-with-a-long-random-secret
BOOTSTRAP_ADMIN_EMAIL=owner@example.com
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-long-initial-password
APP_DOMAIN=hotelapp.charlydob.com
APP_ORIGIN=https://hotelapp.charlydob.com
FRIGATE_BASE_URL=http://frigate:5000
```

Do not include real secrets in Git.

Start HotelApp only:

```bash
docker compose -f docker-compose.hetzner.yml up -d --build
docker compose -f docker-compose.hetzner.yml ps
docker compose -f docker-compose.hetzner.yml logs backend
```

The Hetzner compose publishes only localhost ports:

```text
backend  -> 127.0.0.1:3001
frontend -> 127.0.0.1:3000
```

Configure the host Caddy to terminate HTTPS and proxy:

```caddyfile
hotelapp.charlydob.com {
	handle /api/* {
		reverse_proxy 127.0.0.1:3001
	}

	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
```

The frontend container serves the Vite build over plain HTTP on port `80` inside the container and keeps SPA fallback to `index.html`.

Verify:

```bash
curl -I https://hotelapp.charlydob.com
curl https://hotelapp.charlydob.com/api/health
```

## First Admin

On first backend start, if no `platform_admin` exists, the backend creates one from:

```env
BOOTSTRAP_ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD
```

After the first successful start, the role and password hash live in PostgreSQL. Later restarts do not overwrite the user.

Login at:

```text
https://hotelapp.charlydob.com/login
```

## Tenants And Users

As `platform_admin`:

1. Open `/admin`.
2. Create a tenant with name and slug.
3. Enable modules such as `parking` and `checkout`.
4. Configure integrations for that tenant.
5. Invite users as `tenant_admin` or `staff`.

Invitation flow:

```text
admin creates invite -> /accept-invite/:token -> user sets password -> backend creates membership -> invitation is marked used
```

There is no public signup.

## Frigate

Frigate configuration is per tenant and tenant settings are the source of truth.

For the existing Hetzner server, use this internal URL when configuring the tenant:

```text
http://frigate:5000
```

For standalone or external installations, use a URL reachable from the HotelApp backend, for example:

```text
https://frigate.your-domain.example
http://192.168.1.50:5000
```

If Frigate is on a hotel NAS, expose it through a secure VPN, private network, or authenticated HTTPS reverse proxy.

## Update

Standalone:

```bash
cd HotelApp
git pull
docker compose up -d --build
docker compose ps
```

Existing Hetzner server:

```bash
cd HotelApp
git pull
docker compose -f docker-compose.hetzner.yml up -d --build
docker compose -f docker-compose.hetzner.yml ps
```

Database migrations run on backend startup with `prisma migrate deploy`.

The GitHub production workflow creates a timestamped PostgreSQL custom-format dump and read-only archives of the existing `/data` and `/evidence` volumes before rebuilding or starting containers. Deployment stops before migrations if any backup is missing or empty.

## Backup

For standalone installations, back up the PostgreSQL and HotelApp volumes:

```bash
mkdir -p backups/$(date +%F)
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backups/$(date +%F)/hotelapp.sql
docker run --rm -v hotelapp_postgres-data:/volume -v "$PWD/backups/$(date +%F)":/backup alpine tar czf /backup/postgres-data.tgz -C /volume .
docker run --rm -v hotelapp_app-data:/volume -v "$PWD/backups/$(date +%F)":/backup alpine tar czf /backup/app-data.tgz -C /volume .
docker run --rm -v hotelapp_app-evidence:/volume -v "$PWD/backups/$(date +%F)":/backup alpine tar czf /backup/app-evidence.tgz -C /volume .
cp .env backups/$(date +%F)/env
```

For the existing Hetzner server, PostgreSQL is owned by the shared stack. Back up only HotelApp file volumes from this repo:

```bash
mkdir -p backups/$(date +%F)
docker run --rm -v hotelapp_app-data:/volume -v "$PWD/backups/$(date +%F)":/backup alpine tar czf /backup/app-data.tgz -C /volume .
docker run --rm -v hotelapp_app-evidence:/volume -v "$PWD/backups/$(date +%F)":/backup alpine tar czf /backup/app-evidence.tgz -C /volume .
cp .env backups/$(date +%F)/env
```

Store backups off-server. Keep `.env` and secrets out of GitHub.
