'use strict';

// Einstellungen der PropHunt-Workshop-Maps (Game-Settings-Menue der Map). Auf einem
// Dedicated Server nimmt das Map-Skript sie als "say !config <Name> <Wert>" aus der
// Serverkonsole an. Namen, Defaults und Bereiche stammen aus dem Map-Skript.
// RoundTime ist keine Map-Option, sondern setzt die mp_roundtime-ConVars (Minuten).
const OPTIONS = [
    { name: 'TAGrenade',         type: 'bool',   default: true, label: 'Wallhack-Granaten für Seeker' },
    { name: 'RandomSeekers',     type: 'bool',   default: true, label: 'Seeker jede Runde zufällig' },
    { name: 'ForceReroll',       type: 'bool',   default: true, label: 'Props zur Rundenmitte neu würfeln' },
    { name: 'ForceTaunt',        type: 'bool',   default: true, label: 'Hider müssen jede Minute taunten' },
    { name: 'SeekerRespawnTime', type: 'number', default: 60, min: 5, max: 120, step: 5,   label: 'Versteckzeit bis Seeker spawnen (s)' },
    { name: 'PropMaxRerolls',    type: 'number', default: 3,  min: 0, max: 10,  step: 1,   label: 'Rerolls pro Prop' },
    { name: 'PropMaxClones',     type: 'number', default: 4,  min: 0, max: 10,  step: 1,   label: 'Klone pro Prop' },
    { name: 'MissDamage',        type: 'number', default: 2,  min: 0, max: 25,  step: 1,   label: 'Schaden pro Fehlschuss (0 = aus)' },
    { name: 'RoundTime',         type: 'number', default: 3,  min: 1, max: 60,  step: 0.5, label: 'Rundenzeit (min)', convars: ['mp_roundtime', 'mp_roundtime_defuse', 'mp_roundtime_hostage'] }
];

const BY_NAME = new Map(OPTIONS.map(o => [o.name, o]));

function parseValue(option, raw) {
    if (option.type === 'bool') {
        if (raw === true || raw === 'true') return true;
        if (raw === false || raw === 'false') return false;
        return undefined;
    }
    const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
    if (!Number.isFinite(n) || n < option.min || n > option.max) return undefined;
    if (!Number.isInteger((n - option.min) / option.step)) return undefined;
    return n;
}

// Prueft eine (auch unvollstaendige) Auswahl. Nur bekannte Namen mit gueltigen Werten
// landen in values — daraus werden Konsolenbefehle gebaut, also nichts durchreichen.
function validateConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { values: {}, errors: ['Konfiguration muss ein Objekt sein'] };
    }
    const values = {};
    const errors = [];
    for (const [name, raw] of Object.entries(input)) {
        const option = BY_NAME.get(name);
        if (!option) { errors.push(`Unbekannte Einstellung: ${name}`); continue; }
        const value = parseValue(option, raw);
        if (value === undefined) { errors.push(`Ungültiger Wert für ${name}`); continue; }
        values[name] = value;
    }
    return { values, errors };
}

// Erwartet bereits validierte values.
function buildConfigCommands(values) {
    const commands = [];
    for (const option of OPTIONS) {
        if (!(option.name in values)) continue;
        const value = values[option.name];
        if (option.convars) {
            for (const convar of option.convars) commands.push(`${convar} ${value}`);
        } else {
            commands.push(`say !config ${option.name} ${value}`);
        }
    }
    return commands;
}

module.exports = { OPTIONS, validateConfig, buildConfigCommands };
