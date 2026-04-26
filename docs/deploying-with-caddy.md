# Deploying OpenHermit behind Caddy

Caddy is the simplest way to put OpenHermit on a public domain with HTTPS:
it auto-issues Let's Encrypt certificates, terminates TLS, and reverse-proxies
to the local gateway and web processes. This guide covers two layouts —
single domain (most users) and split subdomains (if you want to expose the
web UI publicly but keep the gateway on a private hostname).

The web UI uses the Web Crypto API for device-key auth, which browsers only
expose on **secure contexts** (HTTPS, `http://localhost`, or `http://127.0.0.1`).
That makes a real HTTPS terminator like Caddy effectively required for any
remote access.

## Prerequisites

- A box with `openhermit` installed (`npm install -g openhermit`) and the
  gateway + web running on their default localhost ports:
  - Gateway: `127.0.0.1:4000` — `hermit gateway start`
  - Web: `127.0.0.1:4310` — `hermit web start`
- A domain pointing at the box (DNS `A` / `AAAA` record).
- Ports **80** and **443** open in your firewall. Caddy needs 80 for the
  ACME HTTP-01 challenge and 443 for HTTPS itself.
- Caddy installed:
  ```bash
  # Debian / Ubuntu
  sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt update && sudo apt install -y caddy
  ```

Make sure the gateway and web are listening on `127.0.0.1` (the defaults), not
`0.0.0.0`. Caddy must be the only public listener:

```bash
hermit gateway status
# Listening on http://127.0.0.1:4000

hermit web status
# Listening on http://127.0.0.1:4310
```

If you previously used `--host 0.0.0.0`, restart with the defaults so the
processes are no longer reachable bypassing Caddy.

## Pattern A — single domain (recommended)

One hostname, one TLS cert, one URL for users to remember. Caddy routes by
path: `/api/*` and `/admin/*` go to the gateway, everything else goes to the
web UI.

```caddy
# /etc/caddy/Caddyfile

hermit.example.com {
    # Gateway: API + admin UI + WebSocket
    handle /api/* {
        reverse_proxy 127.0.0.1:4000
    }
    handle /admin/* {
        reverse_proxy 127.0.0.1:4000
    }

    # Web UI gets everything else
    handle {
        reverse_proxy 127.0.0.1:4310
    }
}
```

Reload:

```bash
sudo systemctl reload caddy
```

Visit `https://hermit.example.com`. The web UI's `gatewayUrl` defaults to
`window.location.origin`, so it talks to the gateway on the same hostname —
the path-prefix split lets Caddy route those calls to the right backend.

WebSocket connections (`/api/agents/<id>/ws`) and Server-Sent Events
(`/api/agents/<id>/sessions/<id>/events`) ride the same `reverse_proxy`
directive — Caddy handles `Upgrade`/`Connection` headers and streaming bodies
natively, no extra config needed.

## Pattern B — split subdomains

Use this if you want the gateway on a different hostname (private DNS,
internal-only, different rate-limiting policy, etc.).

```caddy
# /etc/caddy/Caddyfile

hermit.example.com {
    reverse_proxy 127.0.0.1:4310
}

api.hermit.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

Both hostnames need DNS records pointing at the box. Caddy auto-issues a cert
for each.

After visiting `https://hermit.example.com`, the web UI's **Connect** screen
asks for a gateway URL — enter `https://api.hermit.example.com`. The browser
stores it locally and uses it for HTTP + WebSocket from then on.

## Verifying the deployment

```bash
# Gateway through Caddy (no token → 401, but TLS is up)
curl -i https://hermit.example.com/api/agents
#  HTTP/2 401

# Web UI
curl -I https://hermit.example.com
#  HTTP/2 200
```

Open the browser to `https://hermit.example.com`, you should reach the
Connect/Setup flow. If you see the **"HTTPS required"** banner instead of the
app, the page isn't actually loading over a secure context — double-check
your DNS, firewall, and that you're using the `https://` scheme.

## Behind Cloudflare or another CDN

If you proxy through Cloudflare:

- SSL/TLS mode: **Full (strict)** so Cloudflare verifies Caddy's cert.
- WebSockets are on by default in Cloudflare; no toggle needed for free plans.
- Don't enable aggressive caching for `/api/*` — agents and SSE responses
  must hit Caddy every request.

## Operational notes

- **Restarts**: Caddy reloads in-place (`systemctl reload caddy`); the gateway
  and web reload independently via `hermit gateway start` / `stop` and
  `hermit web start` / `stop`.
- **Logs**:
  - Caddy: `journalctl -u caddy -f`
  - Gateway: `~/.openhermit/gateway.log`
  - Web: `~/.openhermit/web.log`
- **Cert renewal**: Caddy renews automatically; nothing to do.
- **Internal channel callbacks**: Telegram / Discord / Slack adapters call
  back into the gateway via `127.0.0.1:4000`, never through the public
  domain — that means a misconfigured public route can't break inbound
  channel traffic.
