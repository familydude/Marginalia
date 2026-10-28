# Marginalia

A private, quietly classy wiki for your writing projects. Runs on your own machine; your work is stored as plain Markdown files.

## Run it with Docker (recommended for a home server)

```
cp .env.example .env      # then edit .env and set MARGINALIA_PASSWORD
mkdir data                # create it yourself, so it belongs to you and not root
docker compose up -d
```

Open `http://<your-server>:4321` from any device on your network and sign in.

- Your writing is in `./data` on the host, as plain files. Back up that folder.
- The container runs as your user (`UID`/`GID` in `.env`, default 1000), with a read-only filesystem and no extra privileges.
- Set `TZ` in `.env` so "words today" rolls over at your midnight.
- Update after changing the code: `docker compose up -d --build`.
- Logs, including failed sign-in attempts: `docker compose logs -f`.

## Run it without Docker

Needs Node 18 or newer. No `npm install`, as there are no dependencies.

```
node server.js
```

Then open http://localhost:4321. A sample work is placed on the shelf the first time so you can see how things fit together; move it to the trash whenever you like.

## Signing in

Marginalia has a single password (it is a one-writer library). Set it in one of two ways:

1. **`MARGINALIA_PASSWORD` in `.env`** (or the environment). Simplest. Change it and restart to change the password.
2. **`set-password`**, which stores only a scrypt hash in `data/.auth.json`, so the password is not written in plain text anywhere:
   ```
   docker compose run --rm marginalia node server.js set-password    # Docker
   node server.js set-password                                       # without Docker
   ```
   Then restart. Leave `MARGINALIA_PASSWORD` unset in this case, because the environment variable wins if both exist.

Changing the password signs out every device. "Keep me signed in" lasts 30 days; otherwise the session ends when the browser closes (at most 12 hours). After 8 wrong passwords from one address, sign-in is paused for 15 minutes.

If no password is set, Marginalia only runs on `127.0.0.1` (just this computer). It refuses to listen on the network without one.

### Reaching it from outside your home

The built-in sign-in is fine for a home network, but it serves plain HTTP. If you want to reach it from the internet, put it behind a reverse proxy that adds HTTPS, or (simpler and safer) use a VPN such as Tailscale or WireGuard and don't expose the port at all.

A minimal Caddy example (Caddy fetches the certificate itself):

```
writing.example.com {
    reverse_proxy 127.0.0.1:4321
}
```

With a reverse proxy, set `TRUST_PROXY=1` in `.env` (so sign-in limits see real client addresses and cookies are marked Secure), and change the port mapping in `docker-compose.yml` to `"127.0.0.1:4321:4321"` so only the proxy can reach it.

## Options

| Variable              | Default      | Meaning |
|-----------------------|--------------|---------|
| `MARGINALIA_PASSWORD` | (none)       | The sign-in password |
| `PORT`                | `4321`       | Port to listen on |
| `HOST`                | `127.0.0.1`  | `0.0.0.0` to accept connections from the network (Docker sets this) |
| `MARGINALIA_DATA`     | `./data`     | Where your writing lives (`/data` in Docker) |
| `TZ`                  | system       | Time zone for daily word counts, e.g. `Europe/Stockholm` |
| `TRUST_PROXY`         | off          | `1` when behind a reverse proxy that sets `X-Forwarded-*` headers |
| `COOKIE_SECURE`       | `auto`       | `auto` marks cookies Secure when served over HTTPS; or `true` / `false` |
| `MARGINALIA_NO_AUTH`  | off          | `1` to run on the network without a password, only if something in front of it already handles sign-in |

## How it's organised

- **Library** (front page): every work as a volume on a shelf, with stage, word count, progress to goal and when you last touched it.
- **Work dashboard**: title page, stats (manuscript words, goal %, net words today, streak), a thirty-day activity chart and recently touched pages, the ordered **Manuscript** laid out as a multi-column table of contents (reorderable), and the **Codex** — characters, places, lore and notes as tabs of cards, with full-text search across the whole work. The last tab you used is remembered per work. Export compiles the manuscript into one Markdown file.
- **Editor**: a calm single column with Markdown, autosave, a word count for the sitting, read/write toggle, and a focus mode. The side panel shows what links here and everything else in the work, grouped and collapsible.

### Wiki links

Write `[[Ines Calloway]]` or `[[Ines Calloway|Ines]]` on any page. Links to pages that don't exist yet appear dashed; click one to create it. Renaming a page rewrites the links pointing at it across the work.

### Keyboard

- Ctrl/⌘ S — save now (it also autosaves)
- Ctrl/⌘ E — switch between reading and writing
- Esc — leave focus mode
- Double-click a page in reading mode to start writing

## Where your writing lives

```
data/
  projects/
    the-lighthouse-keepers-almanac/
      project.json          ← title, stage, goal, daily word history
      files/
        the-lamp-room.md    ← one Markdown file per page
        ines-calloway.md
  trash/                    ← nothing is ever erased; deleted things land here
  .secret                   ← signs session cookies (created automatically)
  .auth.json                ← password hash, only if you used set-password
```

Each page is ordinary Markdown with a small header:

```
---
title: The Lamp Room
category: manuscript
order: 1
created: 2026-10-26T12:13:05.707Z
---

The lamp was lit at four…
```

You can edit these files in any other editor too, and the whole `data` folder is easy to back up or put under git. To restore something from the trash, move it back into `projects/` (a work) or into its work's `files/` folder (a page, removing the date stamp from the name).

## Code

- `server.js`: the HTTP server and JSON API, built on Node's standard library
- `auth.js`: password check, signed session cookies, sign-in rate limiting
- `public/login.html`: the sign-in page
- `Dockerfile`, `docker-compose.yml`, `.env.example`: for running it in a container
- `public/index.html`, `public/style.css`, `public/app.js`: the front end, plain HTML/CSS/JS
- `public/vendor/marked.js`: the [marked](https://github.com/markedjs/marked) Markdown renderer (MIT licence, included)

Fonts are Cormorant Garamond and EB Garamond from Google Fonts; offline, it falls back to Garamond, Baskerville or Georgia.
