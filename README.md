# CS2 Control Panel

Ein leichtgewichtiges Web-Panel zum Verwalten eines [kus/cs2-modded-server](https://github.com/kus/cs2-modded-server) Containers. Bietet Server-Control, Map-Wechsel, vordefinierte Config-Macros, einen RCON-Terminal und einen geschützten Force-Update-Mechanismus.

## Features

- **Server-Control**: Start/Stop/Restart des CS2 Containers via Docker-Socket
- **PropHunt-Maps**: One-Click Map-Wechsel mit korrektem Setup (Buying aus, Freezetime kurz, Bots weg, alltalk an)
- **Cursed Config**: Macro für Random Rounds + RTD an/aus mit automatischem Reset
- **RCON Terminal**: Beliebige RCON-Befehle absetzen, Command-History per Pfeiltasten
- **Live Stats**: Uptime, Spieler-Count, aktuelle Map
- **Container Logs**: Live-Anzeige der letzten 100 Log-Zeilen
- **Force Update** (Danger Zone): CS2-Daten löschen und neu downloaden, mit doppelter Bestätigung

## Voraussetzungen

- Docker + Docker Compose
- Ein laufender [kus/cs2-modded-server](https://github.com/kus/cs2-modded-server) Container
- RCON aktiviert auf dem CS2-Server (Default bei kus' Image)

## Quick Start

### 1. Repository klonen

```bash
git clone https://github.com/USERNAME/cs2-control.git
cd cs2-control
```

### 2. Konfiguration

```bash
cp .env.example .env
nano .env
```

Werte die du setzen musst:

| Variable | Beschreibung | Beispiel |
|----------|--------------|----------|
| `AUTH_USER` | Login-Username fürs Panel | `admin` |
| `AUTH_PASS` | Login-Passwort (stark wählen!) | `openssl rand -base64 24` |
| `CS2_CONTAINER` | Name deines CS2-Containers | `cs2-modded-server` |
| `RCON_HOST` | IP/Hostname des CS2-Servers | `192.168.178.60` |
| `RCON_PORT` | RCON-Port | `27015` |
| `RCON_PASSWORD` | RCON-Passwort des CS2-Servers | aus CS2 Container Env |
| `HOST_CS2_DATA_PATH` | Host-Pfad zum CS2-Daten-Ordner | `/mnt/cache/cs2moddedserver` |
| `PANEL_PORT` | Port auf dem das Panel läuft | `3006` |

### 3. Starten

**Option A — Pre-built Image von GitHub Container Registry (empfohlen):**

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

Vorteil: kein lokaler Build, schnell, immer aktuell. Voraussetzung: `GHCR_OWNER` in `.env` gesetzt (siehe ["Deployment via GitHub Container Registry"](#deployment-via-github-container-registry)).

**Option B — Lokal bauen:**

```bash
docker compose up -d --build
```

Panel ist erreichbar unter `http://YOUR_HOST:3006`

## Deployment via GitHub Container Registry

Statt das Image auf jedem Server lokal zu bauen, kann GitHub Actions das Image bei jedem Push automatisch bauen und nach **ghcr.io** pushen. Auf dem Server reicht dann ein `docker compose pull && up -d`.

### Einmalig: Repo auf GitHub anlegen

```bash
gh repo create cs2-control --public --source=. --push
```

Sobald gepusht: Der Workflow `.github/workflows/docker-image.yml` läuft automatisch los und published das Image nach `ghcr.io/<USERNAME>/cs2-control:latest`.

Status der Builds:

```bash
gh run list --workflow=docker-image.yml
gh run watch
```

### Package public machen (falls gewünscht)

Standardmäßig ist das ghcr-Package privat. Für public Pull ohne Login:

1. GitHub → dein Profil → **Packages** → `cs2-control`
2. Package settings → **Change visibility** → **Public**

### Auf dem Server deployen

```bash
# .env mit GHCR_OWNER=dein-github-username befüllen
cp .env.example .env
nano .env

# Image pullen + starten
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

**Privates Package?** Vorher einloggen:

```bash
echo $GITHUB_PAT | docker login ghcr.io -u <USERNAME> --password-stdin
```

(PAT mit Scope `read:packages` reicht — auf github.com/settings/tokens generieren)

### Verfügbare Tags

Der Workflow erzeugt automatisch folgende Tags:

| Tag | Wann |
|-----|------|
| `latest` | Bei jedem Push auf `main`/`master` |
| `master` / `main` | Branch-Name |
| `v1.3.0` | Bei git-Tag `v1.3.0` |
| `1.3` | Major.Minor bei git-Tag |
| `sha-abc1234` | Commit-Hash bei jedem Push |

Per `IMAGE_TAG=v1.3.0` in `.env` lässt sich ein spezifischer Tag pinnen.

### Update auf neue Version

```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

(oder im Panel-Container `pull_policy: always` lässt Docker beim `up` immer pullen)

## Security

⚠️ **Wichtig:** Wer ins Panel reinkommt, kann beliebige RCON-Commands absetzen und den Server kontrollieren.

### Starkes Passwort generieren

```bash
openssl rand -base64 24
```

### HTTPS / Remote-Zugriff (empfohlen)

- **Cloudflare Tunnel**: Public Hostname → HTTP → `dein-host:3006` → optional Cloudflare Access davorschalten
- **Tailscale / WireGuard VPN** für privates Setup
- **Niemals** direkt per Port-Forwarding ins Internet öffnen

### Force Update — Schutzmechanismen

Der Force-Update-Button hat **drei Schutzstufen**:

1. Versteckt unter "Danger Zone" Accordion
2. Modal mit dramatischer Warnung
3. Confirm-Phrase `FORCE-UPDATE-JETZT` muss exakt getippt werden + zeitlich begrenzter Token (60s)

Backend-seitig: Path-Guard verhindert dass irgendwas außerhalb des konfigurierten `CS2_DATA_PATH` gelöscht werden kann.

## PropHunt Maps

Standardmäßig konfiguriert:

| Workshop-ID | Map |
|-------------|-----|
| 3608612434 | Inferno PropHunt |
| 3644811896 | Office PropHunt |
| 3711322683 | Nuke PropHunt |
| 3615968422 | Mirage PropHunt |

Eigene Maps in `ALLOWED_MAPS` in `server.js` eintragen, dann Buttons in `public/index.html` anpassen.

## PropHunt Setup-Sequenz

Beim Klick auf eine PropHunt-Map werden folgende Commands gesendet:

1. `exec settings/disable_random_round.cfg` — Random Rounds aus
2. `exec settings/disable_dice.cfg` — RTD aus
3. `exec casual.cfg` — Casual-Mode als Basis
4. PropHunt-Convars: `mp_freezetime 5`, `mp_buy_anywhere 0`, `mp_friendlyfire 0`, `sv_alltalk 1`, etc.
5. `exec_after_map_start "exec settings/disable_bots.cfg"` — Bots werden NACH Map-Load gekickt
6. `host_workshop_map WORKSHOP_ID` — Map laden

## Cursed Config Macros

**AN**: Casual → Random Rounds an → Dice an → disable_bots queue → changelevel de_dust2
**AUS**: Random Rounds aus → Dice aus → Casual → disable_bots queue → changelevel de_dust2

## Eigene Macros hinzufügen

In `server.js` der `MACROS` Map einen Eintrag hinzufügen, dann in `public/index.html` einen Button mit `onclick="macro('macro_id', 'Label')"`.

## Container neu bauen nach Code-Änderungen

**Lokal:**
```bash
docker compose down
docker compose up -d --build
```

**Via ghcr.io** (nach Push auf GitHub):
```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

## Unraid

Die Compose-Dateien setzen die nötigen `net.unraid.docker.*` Labels:

- **Icon**: zieht `/icons/icon.png` vom laufenden Panel selbst — setze `PANEL_HOST` in `.env` auf deine Unraid-IP, sonst zeigt Unraid das Default-Container-Icon
- **WebUI**: Klick aufs Container-Icon im Unraid-Dashboard öffnet `http://<PANEL_HOST>:<PANEL_PORT>` direkt

Alternativ: In der Unraid-WebUI unter Container → Edit → Icon URL einen permanenten Pfad eintragen (z.B. nach `/mnt/user/system/docker/icons/cs2-control.png` kopiert).

## Architektur

- **Backend**: Node.js + Express
- **RCON**: rcon-client (Source RCON Protocol)
- **Docker Control**: dockerode via Docker-Socket
- **Auth**: HTTP Basic Auth
- **Frontend**: Single-Page Vanilla JS, dunkles Theme

## Troubleshooting

### "Connection refused" beim RCON-Connect

- Container läuft? `docker ps | grep cs2-modded-server`
- RCON-Port erreichbar? `nc -zv 192.168.178.60 27015`
- RCON-Passwort korrekt in `.env`?

### "Authentication failed"

RCON-Passwort prüfen:

```bash
docker inspect cs2-modded-server --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i rcon
```

### Bots kommen immer wieder

kus' Casual-Mode hat ein Auto-Refill. Lösung: `bot_join_after_player 0` aus `disable_bots.cfg`. Wichtig: `exec_after_map_start` muss vor dem `changelevel` gesetzt werden, weil Map-Load die ConVars resettet.

### Force Update bleibt hängen

40GB löschen + Re-Download dauert 30-40 Min:

```bash
docker logs -f cs2-modded-server
```

## Lizenz

MIT

## Credits

- [kus/cs2-modded-server](https://github.com/kus/cs2-modded-server) — das CS2-Modded-Server-Image
- [rcon-client](https://github.com/janispritzkau/rcon-client) — RCON-Implementierung
