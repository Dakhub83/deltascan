# Deploying DeltaScan

This puts DeltaScan on the internet at your own domain over HTTPS:

- the landing page at `https://your-domain/`;
- the dashboard at `https://your-domain/app/`, behind a sign-in.

One container runs the app and Caddy in front of it handles the certificate.

## Before you start: two Alpaca limits

- **One stream per Alpaca account.** The deployed server and a local `npm run dev` on live data can't run at the same time; the second one gets `406 connection limit exceeded`. Once the app is deployed, run your local copy with `DATA_PROVIDER=mock`, or use a second Alpaca account for it.
- **Your Alpaca data is licensed for your own use.** Accounts are private by default (`ALLOW_SIGNUP=false`): only the first account can be created, and that one is yours. Don't open sign-ups to other people unless your market-data agreement allows showing the data to them.

## 1. A server and a domain

- **A Linux VPS** with 1 vCPU and 1–2 GB of RAM is plenty. Any provider works, for example Hetzner, DigitalOcean or Vultr; pick a US East region if you can, since it's closer to the exchanges.
- **A domain or subdomain**, such as `scanner.example.com`. At your DNS provider, add an **A record** pointing it at the server's IP address. HTTPS can't be set up until it resolves.

## 2. Install Docker on the server

```bash
curl -fsSL https://get.docker.com | sh
```

## 3. Get the code and settings onto the server

```bash
git clone <your repository URL> deltascan
cd deltascan
cp .env.example .env
nano .env
```

In `.env`, set at least:

| Setting | Value |
|---|---|
| `DOMAIN` | your domain, e.g. `scanner.example.com` (add this line; it isn't in the example) |
| `DATA_PROVIDER` | `alpaca` |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | your keys |
| `SEC_USER_AGENT` | `DeltaScan your-email@example.com` (enables the Dilution window) |

You don't need to set anything else. `docker-compose.yml` already turns on:
- sign-in (`AUTH_REQUIRED`);
- HTTPS cookies and the proxy settings (`COOKIE_SECURE`, `TRUST_PROXY`);
- serving the website (`SERVE_WEB`);
- the database location (`DB_PATH=/data/scanner.db` on a Docker volume).

`.env` holds your keys: never commit it. It's in `.gitignore` and `.dockerignore`.

## 4. Start it

```bash
docker compose up -d --build
```

The first build takes a few minutes. Caddy then fetches the certificate. Check progress with:

```bash
docker compose logs -f
```

## 5. Create your account

1. Open `https://your-domain/app/`. The first visit shows **Create your account**.
2. Sign up with your email and a password (8 characters or more).
3. After that, sign-up is closed, and anyone else who opens the site only sees the sign-in form.

## Everyday operations

| Task | Command |
|---|---|
| Update to the latest code | `git pull && docker compose up -d --build` |
| Restart | `docker compose restart app` |
| Logs | `docker compose logs -f app` |
| Back up accounts, layouts, watchlists and alerts | `docker compose exec app sh -c "cp /data/scanner.db /data/backup.db"`, then `docker compose cp app:/data/backup.db ./backup.db` |

The database lives in the `deltascan-data` volume. It survives rebuilds and upgrades; only `docker compose down -v` deletes it.

## Running in production without Docker

If you'd rather run it directly on a machine with Node 22.5 or later:

```bash
npm ci
npm run build
SERVE_WEB=true AUTH_REQUIRED=true npm start
```

Put a reverse proxy that terminates HTTPS in front of port 4000, such as Caddy or nginx. Then also set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
