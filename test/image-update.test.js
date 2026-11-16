'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildCreateOptions, ensureLatestImage } = require('../lib/image-update');

const OLD_ID = 'sha256:' + 'a'.repeat(64);
const NEW_ID = 'sha256:' + 'b'.repeat(64);

function containerInfo(overrides = {}) {
    return {
        Id: 'c0ffee1234567890',
        Name: '/cs2-modded-server',
        Image: OLD_ID,
        State: { Running: true },
        Config: {
            Image: 'ghcr.io/kus/cs2-modded-server:latest',
            Hostname: 'c0ffee123456',
            Env: ['PATH=/usr/bin', 'RCON_PASSWORD=geheim', 'TICKRATE=128'],
            Cmd: ['bash', 'entry.sh'],
            Entrypoint: null,
            Labels: { 'net.unraid.docker.managed': 'dockerman', 'org.opencontainers.image.version': '1.0.379' },
            ExposedPorts: { '27015/udp': {} },
            Tty: true,
            OpenStdin: true,
            WorkingDir: '/home/steam',
        },
        HostConfig: {
            NetworkMode: 'bridge',
            Binds: ['/mnt/dlcash/cs2moddedserver:/home/steam/cs2:rw'],
            PortBindings: { '27015/udp': [{ HostIp: '', HostPort: '27015' }] },
        },
        NetworkSettings: { Networks: { bridge: { IPAMConfig: null, Aliases: null } } },
        ...overrides,
    };
}

const oldImage = {
    Config: {
        Env: ['PATH=/usr/bin', 'TICKRATE=128'],
        Cmd: ['bash', 'entry.sh'],
        Labels: { 'org.opencontainers.image.version': '1.0.379' },
        WorkingDir: '/home/steam',
    },
};

test('buildCreateOptions übernimmt eigene Einstellungen und lässt Image-Vorgaben weg', () => {
    const opts = buildCreateOptions(containerInfo(), oldImage, 'ghcr.io/kus/cs2-modded-server:latest');
    assert.strictEqual(opts.name, 'cs2-modded-server');
    assert.strictEqual(opts.Image, 'ghcr.io/kus/cs2-modded-server:latest');
    assert.deepStrictEqual(opts.Env, ['RCON_PASSWORD=geheim']);
    assert.deepStrictEqual(opts.Labels, { 'net.unraid.docker.managed': 'dockerman' });
    assert.strictEqual(opts.Cmd, undefined);
    assert.strictEqual(opts.WorkingDir, undefined);
    assert.strictEqual(opts.Hostname, undefined);
    assert.strictEqual(opts.NetworkingConfig, undefined);
    assert.strictEqual(opts.Tty, true);
    assert.deepStrictEqual(opts.HostConfig.Binds, ['/mnt/dlcash/cs2moddedserver:/home/steam/cs2:rw']);
    assert.deepStrictEqual(opts.HostConfig.PortBindings, { '27015/udp': [{ HostIp: '', HostPort: '27015' }] });
});

test('buildCreateOptions behält abweichendes Cmd, gesetzten Hostnamen und feste IP im eigenen Netz', () => {
    const info = containerInfo();
    info.Config.Cmd = ['bash', 'anders.sh'];
    info.Config.Hostname = 'cs2';
    info.HostConfig.NetworkMode = 'br0';
    info.NetworkSettings.Networks = { br0: { IPAMConfig: { IPv4Address: '192.168.178.70' }, Aliases: ['c0ffee123456', 'spiel'] } };
    const opts = buildCreateOptions(info, oldImage, 'x:latest');
    assert.deepStrictEqual(opts.Cmd, ['bash', 'anders.sh']);
    assert.strictEqual(opts.Hostname, 'cs2');
    assert.deepStrictEqual(opts.NetworkingConfig, {
        EndpointsConfig: { br0: { IPAMConfig: { IPv4Address: '192.168.178.70' }, Aliases: ['spiel'] } },
    });
});

test('buildCreateOptions kommt ohne Info zum alten Image aus', () => {
    const opts = buildCreateOptions(containerInfo(), null, 'x:latest');
    assert.deepStrictEqual(opts.Env, ['PATH=/usr/bin', 'RCON_PASSWORD=geheim', 'TICKRATE=128']);
    assert.deepStrictEqual(opts.Cmd, ['bash', 'entry.sh']);
});

// Minimaler Docker-Ersatz, der die Aufrufe mitschreibt.
function fakeDocker({ pulledId = NEW_ID, pullError = null, createError = null, info = containerInfo() } = {}) {
    const calls = [];
    const handle = (ref) => ({
        inspect: async () => info,
        stop: async () => { calls.push(['stop', ref]); },
        rename: async (o) => { calls.push(['rename', o.name, ref]); },
        remove: async () => { calls.push(['remove', ref]); },
    });
    return {
        calls,
        getContainer: handle,
        pull: async (ref) => { calls.push(['pull', ref]); if (pullError) throw pullError; return {}; },
        modem: { followProgress: (stream, cb) => cb(null) },
        getImage: (ref) => ({
            inspect: async () => (ref === OLD_ID ? { Id: OLD_ID, ...oldImage } : { Id: pulledId }),
            remove: async () => { calls.push(['removeImage', ref]); },
        }),
        createContainer: async (o) => { calls.push(['create', o.name, o.Image]); if (createError) throw createError; },
    };
}

test('ensureLatestImage lässt den Container bei unverändertem Image in Ruhe', async () => {
    const docker = fakeDocker({ pulledId: OLD_ID });
    const result = await ensureLatestImage(docker, 'cs2-modded-server');
    assert.strictEqual(result.updated, false);
    assert.deepStrictEqual(docker.calls, [['pull', 'ghcr.io/kus/cs2-modded-server:latest']]);
});

test('ensureLatestImage baut den Container bei neuem Image neu auf', async () => {
    const docker = fakeDocker();
    const result = await ensureLatestImage(docker, 'cs2-modded-server');
    assert.strictEqual(result.updated, true);
    const steps = docker.calls.map(c => c[0]);
    assert.deepStrictEqual(steps, ['pull', 'stop', 'rename', 'create', 'remove', 'removeImage']);
    assert.match(docker.calls[2][1], /^cs2-modded-server_alt_\d+$/);
    assert.deepStrictEqual(docker.calls[3], ['create', 'cs2-modded-server', 'ghcr.io/kus/cs2-modded-server:latest']);
    // Stop, Umbenennen und Löschen müssen über die ID laufen: der Name gehört nach dem
    // Anlegen dem neuen Container.
    for (const i of [1, 2, 4]) assert.strictEqual(docker.calls[i].at(-1), 'c0ffee1234567890');
});

test('ensureLatestImage meldet einen fehlgeschlagenen Pull nur als Warnung', async () => {
    const docker = fakeDocker({ pullError: new Error('kein Netz') });
    const result = await ensureLatestImage(docker, 'cs2-modded-server');
    assert.strictEqual(result.updated, false);
    assert.match(result.warning, /kein Netz/);
    assert.deepStrictEqual(docker.calls.map(c => c[0]), ['pull']);
});

test('ensureLatestImage stellt den alten Container wieder her, wenn das Anlegen scheitert', async () => {
    const docker = fakeDocker({ createError: new Error('port belegt') });
    await assert.rejects(() => ensureLatestImage(docker, 'cs2-modded-server'), /alter Container bleibt bestehen/);
    const renames = docker.calls.filter(c => c[0] === 'rename').map(c => c[1]);
    assert.strictEqual(renames.length, 2);
    assert.strictEqual(renames[1], 'cs2-modded-server');
    assert.ok(!docker.calls.some(c => c[0] === 'remove'));
});

test('ensureLatestImage fasst auf Digest gepinnte Container nicht an', async () => {
    const info = containerInfo();
    info.Config.Image = 'ghcr.io/kus/cs2-modded-server@sha256:' + 'c'.repeat(64);
    const docker = fakeDocker({ info });
    const result = await ensureLatestImage(docker, 'cs2-modded-server');
    assert.strictEqual(result.updated, false);
    assert.deepStrictEqual(docker.calls, []);
});
