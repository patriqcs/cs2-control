'use strict';
// Image-Update vor dem Serverstart: zieht das Image des Containers neu und baut
// den Container bei geändertem Image mit denselben Einstellungen neu auf.
// Hintergrund: Nach CS2-Spielupdates passt der Mod-Stack des alten Images nicht
// mehr zum Spiel, der Server stürzt dann bei jedem Start ab (Exit 139).

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Netzwerk-Modi, die Docker ohne eigene Endpoint-Angaben anlegt.
const isBuiltinNetwork = (mode) =>
    !mode || ['default', 'bridge', 'host', 'none'].includes(mode) || mode.startsWith('container:');

/**
 * Baut die Create-Optionen für den neuen Container aus dem Inspect des alten.
 * Werte, die nur aus dem alten Image geerbt sind (Env, Cmd, Entrypoint, Labels …),
 * werden weggelassen, damit die Vorgaben des neuen Images greifen.
 */
function buildCreateOptions(containerInfo, oldImageInfo, imageRef) {
    const cfg = containerInfo.Config || {};
    const img = (oldImageInfo && oldImageInfo.Config) || {};
    const name = String(containerInfo.Name || '').replace(/^\//, '');

    const imgEnv = new Set(img.Env || []);
    const imgLabels = img.Labels || {};
    const labels = {};
    for (const [k, v] of Object.entries(cfg.Labels || {})) {
        if (imgLabels[k] !== v) labels[k] = v;
    }

    const opts = {
        name,
        Image: imageRef,
        Env: (cfg.Env || []).filter(e => !imgEnv.has(e)),
        Labels: labels,
        ExposedPorts: cfg.ExposedPorts || {},
        Tty: !!cfg.Tty,
        OpenStdin: !!cfg.OpenStdin,
        StdinOnce: !!cfg.StdinOnce,
        AttachStdin: !!cfg.AttachStdin,
        AttachStdout: !!cfg.AttachStdout,
        AttachStderr: !!cfg.AttachStderr,
        HostConfig: containerInfo.HostConfig || {},
    };

    // Nur übernehmen, was vom Image-Standard abweicht.
    for (const key of ['Cmd', 'Entrypoint', 'User', 'WorkingDir', 'StopSignal', 'Healthcheck', 'Volumes']) {
        const value = cfg[key];
        if (value === undefined || value === null || value === '') continue;
        if (!sameJson(value, img[key])) opts[key] = value;
    }
    if (cfg.StopTimeout != null) opts.StopTimeout = cfg.StopTimeout;
    if (cfg.Domainname) opts.Domainname = cfg.Domainname;
    if (cfg.MacAddress) opts.MacAddress = cfg.MacAddress;

    // Hostname nur übernehmen, wenn er gesetzt wurde (Standard = Anfang der Container-ID).
    const id = String(containerInfo.Id || '');
    const mode = opts.HostConfig.NetworkMode;
    if (cfg.Hostname && !(id && id.startsWith(cfg.Hostname)) && mode !== 'host' && !String(mode).startsWith('container:')) {
        opts.Hostname = cfg.Hostname;
    }

    // Eigene Netzwerke: feste IP-Vergabe und Aliase erhalten.
    if (!isBuiltinNetwork(mode)) {
        const net = ((containerInfo.NetworkSettings || {}).Networks || {})[mode];
        const endpoint = {};
        if (net && net.IPAMConfig) endpoint.IPAMConfig = net.IPAMConfig;
        if (net && Array.isArray(net.Aliases)) {
            const aliases = net.Aliases.filter(a => !(id && id.startsWith(a)) && a !== name);
            if (aliases.length) endpoint.Aliases = aliases;
        }
        opts.NetworkingConfig = { EndpointsConfig: { [mode]: endpoint } };
    }
    return opts;
}

function pullImage(docker, imageRef, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Image-Pull nach ${Math.round(timeoutMs / 1000)} s abgebrochen`)), timeoutMs);
        const done = (err) => { clearTimeout(timer); err ? reject(err) : resolve(); };
        docker.pull(imageRef).then(
            stream => docker.modem.followProgress(stream, err => done(err)),
            done
        );
    });
}

/**
 * Zieht das Image des Containers. Hat es sich geändert, wird der Container
 * gestoppt und mit denselben Einstellungen neu angelegt (nicht gestartet).
 *
 * Rückgabe: { updated, imageRef, warning? }. Ein fehlgeschlagener Pull ist kein
 * Fehler (der Start soll trotzdem möglich sein) und kommt als `warning` zurück.
 */
async function ensureLatestImage(docker, containerName, { pullTimeoutMs = 300000, stopTimeout = 30, log = () => {} } = {}) {
    const info = await docker.getContainer(containerName).inspect();
    // Ab hier über die ID arbeiten: nach dem Umbenennen zeigt der Name auf den NEUEN Container.
    const container = docker.getContainer(info.Id);
    const imageRef = info.Config.Image;
    const oldImageId = info.Image;

    // Auf einen Digest oder eine Image-ID festgelegte Container bewusst nicht anfassen.
    if (!imageRef || imageRef.includes('@') || /^(sha256:)?[0-9a-f]{12,64}$/.test(imageRef)) {
        return { updated: false, imageRef, warning: 'Image ist fest gepinnt, kein Update-Check' };
    }

    try {
        await pullImage(docker, imageRef, pullTimeoutMs);
    } catch (err) {
        log(`Image-Pull fehlgeschlagen: ${err.message}`);
        return { updated: false, imageRef, warning: `Image-Check fehlgeschlagen: ${err.message}` };
    }

    const newImageId = (await docker.getImage(imageRef).inspect()).Id;
    if (newImageId === oldImageId) return { updated: false, imageRef };

    log(`Neues Image für ${containerName}: ${oldImageId.slice(7, 19)} -> ${newImageId.slice(7, 19)}, baue Container neu`);
    let oldImageInfo = null;
    try { oldImageInfo = await docker.getImage(oldImageId).inspect(); } catch { /* altes Image schon weg */ }
    const createOptions = buildCreateOptions(info, oldImageInfo, imageRef);

    if (info.State && info.State.Running) await container.stop({ t: stopTimeout });

    // Alten Container erst umbenennen und nach erfolgreichem Anlegen löschen,
    // damit bei einem Fehler nichts verloren geht.
    const backupName = `${containerName}_alt_${Date.now()}`;
    await container.rename({ name: backupName });
    try {
        await docker.createContainer(createOptions);
    } catch (err) {
        await container.rename({ name: containerName });
        throw new Error(`Neuaufbau fehlgeschlagen, alter Container bleibt bestehen: ${err.message}`);
    }
    await container.remove();
    try { await docker.getImage(oldImageId).remove(); } catch { /* wird noch verwendet oder schon weg */ }
    return { updated: true, imageRef, oldImageId, newImageId };
}

module.exports = { buildCreateOptions, ensureLatestImage };
