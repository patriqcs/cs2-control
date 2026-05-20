const express = require('express');
const Docker = require('dockerode');
const basicAuth = require('express-basic-auth');
const { Rcon } = require('rcon-client');
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

async function sendRcon(command) {
    const rcon = await Rcon.connect({
        host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD, timeout: 5000
    });
    try { return await rcon.send(command); } finally { await rcon.end(); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendRconSequence(commands) {
    const results = [];
    for (const item of commands) {
        const cmd = typeof item === 'string' ? item : item.cmd;
        const delayMs = typeof item === 'object' ? (item.delay || 500) : 500;
        try {
            const r = await sendRcon(cmd);
            results.push({ cmd, ok: true, response: r });
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

function buildPropHuntSequence(workshopId, mapName) {
    return [
        { cmd: 'exec settings/disable_random_round.cfg',                 delay: 800 },
        { cmd: 'exec settings/disable_dice.cfg',                         delay: 1000 },
        { cmd: 'exec casual.cfg',                                        delay: 1500 },
        { cmd: 'mp_freezetime 5',                                        delay: 200 },
        { cmd: 'mp_roundtime 3',                                         delay: 200 },
        { cmd: 'mp_roundtime_defuse 3',                                  delay: 200 },
        { cmd: 'mp_friendlyfire 0',                                      delay: 200 },
        { cmd: 'mp_buy_anywhere 0',                                      delay: 200 },
        { cmd: 'mp_buytime 0',                                           delay: 200 },
        { cmd: 'mp_startmoney 0',                                        delay: 200 },
        { cmd: 'mp_maxmoney 0',                                          delay: 200 },
        { cmd: 'mp_afterroundmoney 0',                                   delay: 200 },
        { cmd: 'mp_playercashawards 0',                                  delay: 200 },
        { cmd: 'mp_teamcashawards 0',                                    delay: 200 },
        { cmd: 'mp_warmuptime 30',                                       delay: 200 },
        { cmd: 'mp_maxrounds 10',                                        delay: 200 },
        { cmd: 'sv_alltalk 1',                                           delay: 200 },
        { cmd: 'sv_full_alltalk 1',                                      delay: 500 },
        { cmd: 'exec_after_map_start "exec settings/disable_bots.cfg"',  delay: 200 },
        { cmd: `host_workshop_map ${workshopId}`,                        delay: 0 }
    ];
}

app.post('/api/map', async (req, res) => {
    const { workshopId } = req.body;
    if (!ALLOWED_MAPS[workshopId]) return res.status(400).json({ error: 'Map nicht erlaubt' });
    try {
        const sequence = buildPropHuntSequence(workshopId, ALLOWED_MAPS[workshopId]);
        const results = await sendRconSequence(sequence);
        const failed = results.filter(r => !r.ok);
        if (failed.length > 0) {
            res.status(500).json({ error: `${failed.length} Command(s) fehlgeschlagen`, results });
        } else {
            res.json({ success: true, action: ALLOWED_MAPS[workshopId], count: results.length });
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
            { cmd: 'exec_after_map_start "exec settings/disable_bots.cfg"',  delay: 200 },
            { cmd: 'changelevel de_dust2',                                   delay: 0 }
        ]
    },
    'cursed_off': {
        label: 'Cursed Config AUS',
        sequence: [
            { cmd: 'exec settings/disable_random_round.cfg',                 delay: 800 },
            { cmd: 'exec settings/disable_dice.cfg',                         delay: 1000 },
            { cmd: 'exec casual.cfg',                                        delay: 1500 },
            { cmd: 'exec_after_map_start "exec settings/disable_bots.cfg"',  delay: 200 },
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

app.listen(PORT, () => {
    console.log(`CS2 Control Panel läuft auf Port ${PORT}`);
    console.log(`Container: ${CONTAINER_NAME}`);
    console.log(`RCON: ${RCON_HOST}:${RCON_PORT}`);
    console.log(`CS2 Data Path: ${CS2_DATA_PATH}`);
});
