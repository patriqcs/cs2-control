'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { OPTIONS, validateConfig, buildConfigCommands } = require('../lib/prophunt');

test('validateConfig normalisiert Booleans und Zahlen', () => {
    const { values, errors } = validateConfig({ TAGrenade: false, ForceTaunt: 'true', SeekerRespawnTime: '45', RoundTime: 2.5 });
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(values, { TAGrenade: false, ForceTaunt: true, SeekerRespawnTime: 45, RoundTime: 2.5 });
});

test('validateConfig lehnt unbekannte Namen und Werte ausserhalb des Bereichs ab', () => {
    const { values, errors } = validateConfig({ Parry: true, SeekerRespawnTime: 500, MissDamage: -1, PropMaxClones: 'abc', TAGrenade: 'vielleicht' });
    assert.deepStrictEqual(values, {});
    assert.strictEqual(errors.length, 5);
});

test('validateConfig lehnt Werte ab, die nicht ins Schrittraster passen', () => {
    assert.strictEqual(validateConfig({ SeekerRespawnTime: 42 }).errors.length, 1);
    assert.strictEqual(validateConfig({ PropMaxRerolls: 1.5 }).errors.length, 1);
    assert.deepStrictEqual(validateConfig({ RoundTime: 1.5 }).errors, []);
});

test('validateConfig lehnt Nicht-Objekte ab', () => {
    assert.strictEqual(validateConfig(null).errors.length, 1);
    assert.strictEqual(validateConfig(['TAGrenade']).errors.length, 1);
    assert.strictEqual(validateConfig('TAGrenade true; quit').errors.length, 1);
});

test('buildConfigCommands erzeugt say !config fuer Map-Optionen', () => {
    assert.deepStrictEqual(
        buildConfigCommands({ TAGrenade: false, PropMaxClones: 6 }),
        ['say !config TAGrenade false', 'say !config PropMaxClones 6']
    );
});

test('buildConfigCommands setzt die Rundenzeit ueber alle mp_roundtime-ConVars', () => {
    assert.deepStrictEqual(
        buildConfigCommands({ RoundTime: 4 }),
        ['mp_roundtime 4', 'mp_roundtime_defuse 4', 'mp_roundtime_hostage 4']
    );
});

test('Defaults aller Optionen sind selbst gueltig', () => {
    const defaults = Object.fromEntries(OPTIONS.map(o => [o.name, o.default]));
    const { values, errors } = validateConfig(defaults);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(values, defaults);
});
