const express = require('express');
const Docker = require('dockerode');
const basicAuth = require('express-basic-auth');
const { sendRcon: rconSend } = require('./lib/rcon');
const prophunt = require('./lib/prophunt');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const CONTAINER_NAME = process.env.CS2_CONTAINER || 'cs2-modded-server';
const RCON_HOST = process.env.RCON_HOST || '192.168.178.60';
const RCON_PORT = parseInt(process.env.RCON_PORT || '27015');
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';
const PORT = process.env.PORT || 3000;
const CS2_DATA_PATH = process.env.CS2_DATA_PATH || '/cs2-data';

app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));
app.use(basicAuth({
    users: { [process.env.AUTH_USER || 'admin']: process.env.AUTH_PASS || 'changeme' },
    challenge: true,
    realm: 'CS2 Server Control'
}));
app.use(express.static('public'));
app.use(express.json());

function sendRcon(command) {
    return rconSend(command, { host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD, timeout: 5000 });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendRconSequence(commands) {
    const results = [];
    for (const item of commands) {
        const cmd = typeof item === 'string' ? item : item.cmd;
        const delayMs = typeof item === 'object' ? (item.delay ?? 500) : 500;
        try {
            const r = await sendRcon(cmd);
            // CS2 meldet unbekannte Commands als normale Text-Response, nicht als Fehler
            // (z.B. wenn das CS2_ExecAfter-Plugin nach einem Update nicht laedt).
            if (/unknown command/i.test(r || '')) {
                results.push({ cmd, ok: false, error: r.trim() });
            } else {
                results.push({ cmd, ok: true, response: r });
            }
        } catch (err) {
            results.push({ cmd, ok: false, error: err.message });
        }
        await sleep(delayMs);
    }
    return results;
}

app.get('/api/status', async (req, res) => {
    try {
        const container = docker.getContainer(CONTAINER_NAME);
        const info = await container.inspect();
        let playerCount = null, currentMap = null;

        if (info.State.Running) {
            try {
                const statusResp = await sendRcon('status');
                const playerMatch = statusResp.match(/players\s*:\s*(\d+)\s*humans/i);
                const mapMatch = statusResp.match(/\[1:\s*([^\s|]+)/);
                if (playerMatch) playerCount = parseInt(playerMatch[1]);
                if (mapMatch) currentMap = mapMatch[1];
            } catch (e) { /* ignore */ }
        }

        res.json({
            state: info.State.Status,
            running: info.State.Running,
            uptime: info.State.Running ? Math.floor((Date.now() - new Date(info.State.StartedAt).getTime()) / 1000) : 0,
            restartCount: info.RestartCount,
            playerCount, currentMap
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/start', async (req, res) => {
    try { await docker.getContainer(CONTAINER_NAME).start(); res.json({ success: true, action: 'gestartet' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/stop', async (req, res) => {
    try { await docker.getContainer(CONTAINER_NAME).stop({ t: 30 }); res.json({ success: true, action: 'gestoppt' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/restart', async (req, res) => {
    try { await docker.getContainer(CONTAINER_NAME).restart({ t: 30 }); res.json({ success: true, action: 'neugestartet' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

const ALLOWED_MAPS = {
    '3608612434': 'Inferno PropHunt',
    '3644811896': 'Office PropHunt',
    '3711322683': 'Nuke PropHunt',
    '3615968422': 'Mirage PropHunt'
};

const PROPHUNT_CONVARS = [
    'mp_freezetime 5',
    'mp_roundtime 3',
    'mp_roundtime_defuse 3',
    'mp_friendlyfire 0',
    'mp_buy_anywhere 0',
    'mp_buytime 0',
    'mp_startmoney 0',
    'mp_maxmoney 0',
    'mp_afterroundmoney 0',
    'mp_playercashawards 0',
    'mp_teamcashawards 0',
    'mp_warmuptime 30',
    'mp_maxrounds 10'
];

// Map-Load fuehrt die gamemode-cfg neu aus und resettet ConVars — alles, was danach
// gelten soll, gehoert in exec_after_map_start (Plugin CS2_ExecAfter). Das Plugin
// speichert nur EINEN String, ein zweiter Aufruf ueberschreibt den ersten — daher
// hier alles kombinieren. casual_settings.cfg zuerst, weil kus' casual.cfg diese
// selbst per exec_after_map_start queued und unser Aufruf den Eintrag sonst verwirft.
function afterMapStart(commands) {
    const all = ['exec casual_settings.cfg', 'exec settings/disable_bots.cfg', ...commands];
    return { cmd: `exec_after_map_start "${all.join('; ')}"`, delay: 200 };
}

// Die PropHunt-Einstellungen aus dem Panel gehen als eigene cfg in den Map-Start-Hook:
// alle Befehle direkt im exec_after_map_start-String wuerden die Konsolen-Zeilenlaenge sprengen.
const PROPHUNT_CFG_NAME = 'panel_prophunt.cfg';
const PROPHUNT_CFG_PATH = path.join(CS2_DATA_PATH, 'game', 'csgo', 'cfg', PROPHUNT_CFG_NAME);

function buildPropHuntSequence(workshopId, withPanelConfig) {
    const afterStart = [...PROPHUNT_CONVARS, 'sv_alltalk 1', 'sv_full_alltalk 1'];
    if (withPanelConfig) afterStart.push(`exec ${PROPHUNT_CFG_NAME}`);
    return [
        { cmd: 'exec settings/disable_random_round.cfg',                 delay: 800 },
        { cmd: 'exec settings/disable_dice.cfg',                         delay: 1000 },
        { cmd: 'exec casual.cfg',                                        delay: 1500 },
        afterMapStart(afterStart),
        { cmd: `host_workshop_map ${workshopId}`,                        delay: 0 }
    ];
}

app.post('/api/map', async (req, res) => {
    const { workshopId, config } = req.body;
    if (!ALLOWED_MAPS[workshopId]) return res.status(400).json({ error: 'Map nicht erlaubt' });
    let commands = [];
    if (config !== undefined) {
        const { values, errors } = prophunt.validateConfig(config);
        if (errors.length > 0) return res.status(400).json({ error: errors.join(', ') });
        commands = prophunt.buildConfigCommands(values);
    }
    if (commands.length > 0) {
        try { await fs.writeFile(PROPHUNT_CFG_PATH, commands.join('\n') + '\n'); }
        catch (err) { return res.status(500).json({ error: `${PROPHUNT_CFG_NAME}: ${err.message}` }); }
    }
    try {
        const sequence = buildPropHuntSequence(workshopId, commands.length > 0);
        const results = await sendRconSequence(sequence);
        const failed = results.filter(r => !r.ok);
        if (failed.length > 0) {
            res.status(500).json({ error: `${failed.length} Command(s) fehlgeschlagen`, results });
        } else {
            res.json({ success: true, action: ALLOWED_MAPS[workshopId], count: results.length });
        }
    } catch (err) { res.status(500).json({ error: `RCON: ${err.message}` }); }
});

app.get('/api/prophunt-config', (req, res) => res.json({ options: prophunt.OPTIONS }));

app.post('/api/prophunt-config', async (req, res) => {
    const { values, errors } = prophunt.validateConfig(req.body && req.body.config);
    if (errors.length > 0) return res.status(400).json({ error: errors.join(', ') });
    const commands = prophunt.buildConfigCommands(values);
    if (commands.length === 0) return res.status(400).json({ error: 'Keine Einstellungen übergeben' });
    try {
        const results = await sendRconSequence(commands.map(cmd => ({ cmd, delay: 150 })));
        const failed = results.filter(r => !r.ok);
        if (failed.length > 0) {
            res.status(500).json({ error: `${failed.length} Command(s) fehlgeschlagen`, results });
        } else {
            res.json({ success: true, count: results.length });
        }
    } catch (err) { res.status(500).json({ error: `RCON: ${err.message}` }); }
});

const SETTINGS = {
    'random_round_on':  { cmd: 'exec settings/enable_random_round.cfg',  label: 'Random Rounds AN' },
    'random_round_off': { cmd: 'exec settings/disable_random_round.cfg', label: 'Random Rounds AUS' },
    'dice_on':          { cmd: 'exec settings/enable_dice.cfg',          label: 'Dice AN' },
    'dice_off':         { cmd: 'exec settings/disable_dice.cfg',         label: 'Dice AUS' }
};
app.post('/api/setting', async (req, res) => {
    const { id } = req.body;
    if (!SETTINGS[id]) return res.status(400).json({ error: 'Setting nicht erlaubt' });
    try {
        const response = await sendRcon(SETTINGS[id].cmd);
        res.json({ success: true, action: SETTINGS[id].label, response });
    } catch (err) { res.status(500).json({ error: `RCON: ${err.message}` }); }
});

const MACROS = {
    'cursed_on': {
        label: 'Cursed Config AN',
        sequence: [
            { cmd: 'exec casual.cfg',                                        delay: 1500 },
            { cmd: 'exec settings/enable_random_round.cfg',                  delay: 800 },
            { cmd: 'exec settings/enable_dice.cfg',                          delay: 1000 },
            // Sofort-Fallback, falls changelevel fehlschlaegt und der Hook nie feuert
            { cmd: 'sv_alltalk 0',                                           delay: 200 },
            { cmd: 'sv_full_alltalk 0',                                      delay: 200 },
            afterMapStart(['sv_alltalk 0', 'sv_full_alltalk 0']),
            { cmd: 'changelevel de_dust2',                                   delay: 0 }
        ]
    },
    'cursed_off': {
        label: 'Cursed Config AUS',
        sequence: [
            { cmd: 'exec settings/disable_random_round.cfg',                 delay: 800 },
            { cmd: 'exec settings/disable_dice.cfg',                         delay: 1000 },
            { cmd: 'exec casual.cfg',                                        delay: 1500 },
            // Sofort-Fallback, falls changelevel fehlschlaegt und der Hook nie feuert
            { cmd: 'sv_alltalk 0',                                           delay: 200 },
            { cmd: 'sv_full_alltalk 0',                                      delay: 200 },
            afterMapStart(['sv_alltalk 0', 'sv_full_alltalk 0']),
            { cmd: 'changelevel de_dust2',                                   delay: 0 }
        ]
    }
};
app.post('/api/macro', async (req, res) => {
    const { id } = req.body;
    if (!MACROS[id]) return res.status(400).json({ error: 'Macro nicht erlaubt' });
    try {
        const results = await sendRconSequence(MACROS[id].sequence);
        const failed = results.filter(r => !r.ok);
        if (failed.length > 0) {
            res.status(500).json({ error: `${failed.length} Command(s) fehlgeschlagen`, results });
        } else {
            res.json({ success: true, action: MACROS[id].label, count: results.length });
        }
    } catch (err) { res.status(500).json({ error: `RCON: ${err.message}` }); }
});

app.post('/api/rcon', async (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== 'string' || command.length > 500) {
        return res.status(400).json({ error: 'Ungültiger Command' });
    }
    try {
        const response = await sendRcon(command.trim());
        res.json({ success: true, command, response: response || '(kein Response)' });
    } catch (err) { res.status(500).json({ error: `RCON: ${err.message}` }); }
});

app.get('/api/logs', async (req, res) => {
    try {
        const logs = await docker.getContainer(CONTAINER_NAME).logs({
            stdout: true, stderr: true, tail: 100, timestamps: true
        });
        res.type('text/plain').send(logs.toString());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

let pendingTokens = new Map();
app.post('/api/force-update/token', (req, res) => {
    const token = crypto.randomBytes(16).toString('hex');
    pendingTokens.set(token, { createdAt: Date.now() });
    setTimeout(() => pendingTokens.delete(token), 60000);
    res.json({ token, expiresIn: 60 });
});

async function rmrf(target) {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(CS2_DATA_PATH) || resolved === '/' || resolved.length < 5) {
        throw new Error('Pfad nicht erlaubt');
    }
    await fs.rm(resolved, { recursive: true, force: true });
}

app.post('/api/force-update', async (req, res) => {
    const { token, confirm } = req.body;
    if (!token || !pendingTokens.has(token)) return res.status(400).json({ error: 'Ungültiger oder abgelaufener Token' });
    pendingTokens.delete(token);
    if (confirm !== 'FORCE-UPDATE-JETZT') return res.status(400).json({ error: 'Bestätigung fehlt oder falsch' });

    try {
        const container = docker.getContainer(CONTAINER_NAME);
        try { await container.stop({ t: 60 }); } catch (e) { /* schon gestoppt */ }
        const entries = await fs.readdir(CS2_DATA_PATH);
        for (const entry of entries) await rmrf(path.join(CS2_DATA_PATH, entry));
        await container.start();
        res.json({ success: true, action: 'Force Update gestartet', note: 'Container neu gestartet, CS2 wird neu heruntergeladen (~30-40 Min)' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// Palworld (palchaos-server auf demselben Host, gesteuert über den Docker-Socket)
// ============================================================================
const PAL_CONTAINER = process.env.PALWORLD_CONTAINER || 'palchaos-server';
const PAL_GAME_HOST_PATH = process.env.PALWORLD_GAME_HOST_PATH || '/mnt/cache/appdata/palchaos-server/game';
const PAL_UPDATE_IMAGE = process.env.PALWORLD_UPDATE_IMAGE || 'ghcr.io/adam2893/palworld-proton-server:latest';
const PAL_APPID = process.env.PALWORLD_APPID || '2394010';

// SteamCMD-Update im Wegwerf-Container gegen das game-Volume des Servers.
// app_info_update + doppeltes app_update sind Absicht: mit frischem SteamCMD-
// Cache bricht der erste Lauf sonst mit "state 0x6" / "Missing configuration" ab.
const PAL_STEAMCMD_SCRIPT = [
    'gosu steam /home/steam/steamcmd/steamcmd.sh',
    '+@sSteamCmdForcePlatformType windows',
    '+force_install_dir /palworld',
    '+login anonymous',
    '+app_info_update 1',
    `+app_update ${PAL_APPID} validate`,
    `+app_update ${PAL_APPID} validate`,
    '+quit'
].join(' ');

const palUpdateJob = {
    running: false, startedAt: null, finishedAt: null, success: null, log: []
};

function palLog(line) {
    const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').trimEnd();
    if (!clean) return;
    palUpdateJob.log.push(`[${new Date().toLocaleTimeString('de-DE')}] ${clean}`);
    if (palUpdateJob.log.length > 400) palUpdateJob.log.splice(0, palUpdateJob.log.length - 400);
}

async function palEnsureUpdateImage() {
    try {
        await docker.getImage(PAL_UPDATE_IMAGE).inspect();
    } catch {
        palLog(`Update-Image nicht lokal, ziehe ${PAL_UPDATE_IMAGE} ...`);
        const stream = await docker.pull(PAL_UPDATE_IMAGE);
        await new Promise((resolve, reject) =>
            docker.modem.followProgress(stream, err => err ? reject(err) : resolve()));
        palLog('Image gezogen.');
    }
}

async function palRunSteamcmd() {
    const { Writable } = require('stream');
    let tail = '';
    const sink = new Writable({
        write(chunk, enc, cb) {
            const lines = (tail + chunk.toString()).split('\n');
            tail = lines.pop();
            // SteamCMD spammt Progress-Zeilen im Sekundentakt — nur jede Änderung loggen
            for (const l of lines) palLog(l);
            cb();
        }
    });
    const [result] = await docker.run(PAL_UPDATE_IMAGE, ['-c', PAL_STEAMCMD_SCRIPT], sink, {
        Entrypoint: ['sh'],
        Tty: true,
        HostConfig: {
            Binds: [`${PAL_GAME_HOST_PATH}:/palworld`],
            AutoRemove: true
        }
    });
    if (tail) palLog(tail);
    return result;
}

async function palRunUpdate() {
    const container = docker.getContainer(PAL_CONTAINER);
    try {
        palLog('=== Palworld-Update gestartet ===');

        let wasRunning = false;
        try {
            wasRunning = (await container.inspect()).State.Running;
        } catch (e) {
            throw new Error(`Container ${PAL_CONTAINER} nicht gefunden: ${e.message}`);
        }

        if (wasRunning) {
            palLog(`Stoppe ${PAL_CONTAINER} (Spieler werden getrennt) ...`);
            await container.stop({ t: 60 });
            palLog('Container gestoppt.');
        } else {
            palLog(`${PAL_CONTAINER} läuft nicht — Update ohne Stop.`);
        }

        await palEnsureUpdateImage();
        palLog('Starte SteamCMD-Update (kann einige Minuten dauern) ...');
        const result = await palRunSteamcmd();

        const success = palUpdateJob.log.some(l => /Success!.*fully installed/i.test(l));
        if (!success) {
            throw new Error(`SteamCMD ohne Erfolgsmeldung beendet (Exit ${result?.StatusCode ?? '?'})`);
        }
        palLog('SteamCMD: Update erfolgreich installiert.');

        palLog(`Starte ${PAL_CONTAINER} neu ...`);
        await container.start();
        palLog('Container gestartet — Server bootet (UE4SS + Mod laden, ~1-2 Min).');
        palLog('=== Palworld-Update abgeschlossen ===');
        palUpdateJob.success = true;
    } catch (err) {
        palLog(`FEHLER: ${err.message}`);
        palUpdateJob.success = false;
        // Server trotzdem wieder hochbringen, sonst bleibt er nach Fehlschlag unten
        try {
            const info = await container.inspect();
            if (!info.State.Running) {
                palLog(`Versuche ${PAL_CONTAINER} trotzdem zu starten ...`);
                await container.start();
                palLog('Container gestartet (alte Version).');
            }
        } catch (e) { palLog(`Neustart fehlgeschlagen: ${e.message}`); }
    } finally {
        palUpdateJob.running = false;
        palUpdateJob.finishedAt = Date.now();
    }
}

app.get('/api/palworld/status', async (req, res) => {
    try {
        const info = await docker.getContainer(PAL_CONTAINER).inspect();
        res.json({
            container: PAL_CONTAINER,
            state: info.State.Status,
            running: info.State.Running,
            health: info.State.Health ? info.State.Health.Status : null,
            uptime: info.State.Running ? Math.floor((Date.now() - new Date(info.State.StartedAt).getTime()) / 1000) : 0,
            updating: palUpdateJob.running
        });
    } catch (err) { res.status(500).json({ error: err.message, container: PAL_CONTAINER }); }
});

app.post('/api/palworld/start', async (req, res) => {
    if (palUpdateJob.running) return res.status(409).json({ error: 'Update läuft gerade' });
    try { await docker.getContainer(PAL_CONTAINER).start(); res.json({ success: true, action: 'gestartet' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/palworld/stop', async (req, res) => {
    if (palUpdateJob.running) return res.status(409).json({ error: 'Update läuft gerade' });
    try { await docker.getContainer(PAL_CONTAINER).stop({ t: 60 }); res.json({ success: true, action: 'gestoppt' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/palworld/update', (req, res) => {
    if (palUpdateJob.running) return res.status(409).json({ error: 'Update läuft bereits' });
    palUpdateJob.running = true;
    palUpdateJob.startedAt = Date.now();
    palUpdateJob.finishedAt = null;
    palUpdateJob.success = null;
    palUpdateJob.log = [];
    palRunUpdate(); // läuft asynchron weiter, Fortschritt über /api/palworld/update/status
    res.json({ success: true, action: 'Update gestartet' });
});

app.get('/api/palworld/update/status', (req, res) => {
    res.json(palUpdateJob);
});

// Savegame-Export: erst den Server über seine REST-API speichern lassen
// (best effort — ohne REST ist der Snapshot dank AutoSaveSpan=60 höchstens
// eine Minute alt), dann einen konsistenten Snapshot per Wegwerf-Container
// ziehen und als tar.gz-Download ausliefern.
const PAL_REST_URL = process.env.PALWORLD_REST_URL || 'http://palchaos-server:8212';

async function palAdminPassword() {
    const info = await docker.getContainer(PAL_CONTAINER).inspect();
    const entry = (info.Config.Env || []).find(e => e.startsWith('ADMIN_PASSWORD='));
    return entry ? entry.slice('ADMIN_PASSWORD='.length) : '';
}

async function palTriggerSave() {
    const auth = Buffer.from(`admin:${await palAdminPassword()}`).toString('base64');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
        const r = await fetch(`${PAL_REST_URL}/v1/api/save`, {
            method: 'POST',
            headers: { Authorization: `Basic ${auth}` },
            signal: ctl.signal
        });
        if (!r.ok) throw new Error(`REST /save → HTTP ${r.status}`);
    } finally { clearTimeout(timer); }
}

// Kopieren, bis der Stand stabil ist (Level.sav-Prüfsummen unverändert und
// kein halbfertiger Atomic-Save *.new_tmp) — der Server speichert alle 60 s.
const PAL_EXPORT_SCRIPT = [
    'SRC=/palworld/Pal/Saved/SaveGames/0; TMP=/tmp/snap;',
    'for i in 1 2 3; do',
    '  rm -rf $TMP; mkdir -p $TMP;',
    '  S1=$(md5sum $SRC/*/Level.sav 2>/dev/null | md5sum);',
    '  cp -a $SRC/. $TMP/;',
    '  S2=$(md5sum $SRC/*/Level.sav 2>/dev/null | md5sum);',
    '  if [ "$S1" = "$S2" ] && ! ls $SRC/*/*.new_tmp >/dev/null 2>&1; then break; fi;',
    '  sleep 3;',
    'done;',
    'tar czf - -C $TMP .'
].join(' ');

app.get('/api/palworld/export', async (req, res) => {
    if (palUpdateJob.running) return res.status(409).json({ error: 'Update läuft gerade' });
    try {
        let saveTriggered = true;
        try {
            await palTriggerSave();
        } catch (e) {
            saveTriggered = false;
            console.log(`Palworld-Export: REST-Save nicht möglich (${e.message}), exportiere letzten Autosave`);
        }

        await palEnsureUpdateImage();
        const { Writable } = require('stream');
        const chunks = [];
        const stdout = new Writable({ write(c, enc, cb) { chunks.push(c); cb(); } });
        const stderr = new Writable({ write(c, enc, cb) { cb(); } });
        const [result] = await docker.run(PAL_UPDATE_IMAGE, ['-c', PAL_EXPORT_SCRIPT], [stdout, stderr], {
            Entrypoint: ['sh'],
            Tty: false,
            HostConfig: {
                Binds: [`${PAL_GAME_HOST_PATH}:/palworld:ro`],
                AutoRemove: true
            }
        });

        const archive = Buffer.concat(chunks);
        // tar.gz beginnt mit dem gzip-Magic 1f 8b — alles andere ist ein Fehlerfall
        if (result?.StatusCode !== 0 || archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
            throw new Error(`Snapshot fehlgeschlagen (Exit ${result?.StatusCode ?? '?'}, ${archive.length} Bytes)`);
        }

        const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
        res.set({
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="palchaos-save-${stamp}.tar.gz"`,
            'X-Save-Triggered': saveTriggered ? 'yes' : 'no'
        });
        res.send(archive);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/palworld/logs', async (req, res) => {
    try {
        const logs = await docker.getContainer(PAL_CONTAINER).logs({
            stdout: true, stderr: true, tail: 100, timestamps: true
        });
        res.type('text/plain').send(logs.toString());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const server = app.listen(PORT, () => {
    console.log(`CS2 Control Panel läuft auf Port ${PORT}`);
    console.log(`Container: ${CONTAINER_NAME}`);
    console.log(`RCON: ${RCON_HOST}:${RCON_PORT}`);
    console.log(`CS2 Data Path: ${CS2_DATA_PATH}`);
    console.log(`Palworld-Container: ${PAL_CONTAINER}`);
});

// Graceful Shutdown: Node läuft im Container als PID 1 und hat dort keinen
// Default-Handler für SIGTERM. Ohne diesen Block wartet `docker stop` das
// volle Timeout ab (auf Unraid 120 s) und killt dann hart (Exit 137).
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} empfangen, beende Server…`);
    const hardExit = setTimeout(() => {
        console.error('Shutdown-Timeout, beende hart');
        process.exit(1);
    }, 5000);
    hardExit.unref();
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
