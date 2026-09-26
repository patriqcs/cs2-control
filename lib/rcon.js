'use strict';
const { Rcon } = require('rcon-client');

// Eine RCON-Verbindung pro Befehl: verbinden, senden, schliessen.
//
// rcon-client reicht Socket-Fehler nach dem TCP-Connect als 'error'-Event an
// die Rcon-Instanz weiter. Ohne Listener beendet Node den ganzen Prozess
// (Unhandled 'error' event). Auf Unraid passiert genau das, sobald der
// docker-proxy die Verbindung auf 27015 annimmt und resettet, weil im
// CS2-Container gerade kein Server lauscht (Download, Crash, Map-Wechsel).
// Mit Listener rejecten die ausstehenden Pakete sauber ("Connection closed").
async function sendRcon(command, config) {
    const rcon = new Rcon(config);
    rcon.on('error', () => { /* Fehler landet ueber 'end' in der ausstehenden Promise */ });
    await rcon.connect();
    try {
        return await rcon.send(command);
    } finally {
        try { await rcon.end(); } catch (e) { /* Socket bereits weg */ }
    }
}

module.exports = { sendRcon };
