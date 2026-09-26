'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { sendRcon } = require('../lib/rcon');

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Nachstellung des Unraid-Falls: docker-proxy nimmt die TCP-Verbindung an und
// resettet sie, weil im Container (noch) kein CS2 auf 27015 lauscht.
test('RCON-Reset nach Connect laesst sendRcon fehlschlagen statt den Prozess zu beenden', async () => {
    const server = net.createServer(socket => {
        socket.once('data', () => socket.resetAndDestroy());
    });
    const port = await listen(server);
    try {
        await assert.rejects(sendRcon('status', { host: '127.0.0.1', port, password: 'x', timeout: 1000 }));
    } finally {
        server.close();
    }
});

test('RCON-Reset direkt nach Connect (ohne Daten) laesst sendRcon fehlschlagen', async () => {
    const server = net.createServer(socket => setImmediate(() => socket.resetAndDestroy()));
    const port = await listen(server);
    try {
        await assert.rejects(sendRcon('status', { host: '127.0.0.1', port, password: 'x', timeout: 1000 }));
    } finally {
        server.close();
    }
});

test('Erfolgreicher RCON-Roundtrip liefert die Antwort', async () => {
    const { encodePacket, decodePacket, PacketType } = require('rcon-client/lib/packet');
    const server = net.createServer(socket => {
        socket.on('data', buf => {
            const p = decodePacket(buf);
            if (p.type === PacketType.Auth) {
                socket.write(encodePacket({ id: p.id, type: PacketType.AuthResponse, payload: Buffer.alloc(0) }));
            } else {
                socket.write(encodePacket({ id: p.id, type: PacketType.CommandResponse, payload: Buffer.from('hostname: test') }));
            }
        });
    });
    const port = await listen(server);
    try {
        const r = await sendRcon('status', { host: '127.0.0.1', port, password: 'x', timeout: 1000 });
        assert.match(r, /hostname: test/);
    } finally {
        server.close();
    }
});
