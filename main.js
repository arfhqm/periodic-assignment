import * as THREE from 'three';
import TWEEN from 'three/addons/libs/tween.module.js';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { CONFIG } from './config.js';

/* ======================= Constants ======================= */

const TRANSITION_MS = 2000;
const GOOGLE_TIMEOUT_MS = 10000;

const NET_WORTH = { ORANGE_MIN: 100_000, GREEN_MIN: 200_000 };

const LAYOUT = {
    table: { cols: 20, rows: 10, gapX: 140, gapY: 180 },
    sphere: { radius: 800 },
    helix: { radius: 900, turn: 0.35, stepY: 16 },   // double helix: 2 strands
    grid: { cols: 5, rows: 4, gapX: 400, gapY: 400, gapZ: 500 }, // 5 x 4 x 10
};

const LAYOUT_NAMES = ['table', 'sphere', 'helix', 'grid'];

/* ======================= DOM helpers ======================= */

const $ = (id) => document.getElementById(id);
const setStatus = (msg = '') => { $('status').textContent = msg; };

/* ======================= State ======================= */

let camera, scene, renderer, controls;
const objects = [];
const targets = { table: [], sphere: [], helix: [], grid: [] };

/* ======================= Google login ======================= */

function waitForGoogle() {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (window.google?.accounts?.oauth2) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started > GOOGLE_TIMEOUT_MS) {
                clearInterval(timer);
                reject(new Error('Google sign-in failed to load. Check your connection and refresh.'));
            }
        }, 100);
    });
}

function createTokenClient(onSuccess) {
    return google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: CONFIG.SCOPE,
        callback: (resp) => {
            if (resp.error) {
                setStatus('Login failed: ' + resp.error);
                return;
            }
            onSuccess();
        },
        error_callback: (err) => setStatus('Login cancelled or blocked (' + (err?.type ?? 'unknown') + ').'),
    });
}

/* ======================= Google Sheets ======================= */

async function sheetsGet(path) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}${path}${sep}key=${CONFIG.API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error?.message ?? ''; } catch { /* ignore */ }
        console.error('Sheets API error', res.status, detail);
        throw new Error(`Sheets request failed (${res.status}): ${detail || 'no details'}`);
    }
    return res.json();
}

async function fetchRows() {
    const meta = await sheetsGet('?fields=sheets.properties.title');
    const title = meta.sheets?.[0]?.properties?.title;
    if (!title) throw new Error('The spreadsheet has no sheets.');

    const data = await sheetsGet('/values/' + encodeURIComponent(title));
    const [header = [], ...body] = data.values ?? [];
    const keys = header.map((h) => h.trim().toLowerCase());

    return body
        .filter((r) => r.some((c) => c && c.trim() !== ''))
        .map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/* ======================= Data helpers ======================= */

function parseMoney(value) {
    const n = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isNaN(n) ? 0 : n;
}

function tierFor(netWorth) {
    if (netWorth > NET_WORTH.GREEN_MIN) return 'green';
    if (netWorth >= NET_WORTH.ORANGE_MIN) return 'orange';
    return 'red';
}

const formatMoney = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });

/* ======================= Tiles ======================= */

function div(className, text) {
    const el = document.createElement('div');
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function createTile(row, index) {
    const netWorth = parseMoney(row['net worth']);

    const el = div(`element tier-${tierFor(netWorth)}`);
    el.append(div('number', index + 1), div('name', row.name ?? ''));

    const photo = document.createElement('img');
    photo.className = 'photo';
    photo.alt = row.name ?? '';
    photo.referrerPolicy = 'no-referrer';
    photo.loading = 'lazy';
    photo.src = row.photo ?? '';
    photo.addEventListener('error', () => { photo.style.visibility = 'hidden'; });
    el.append(photo);

    const details = div('details');
    [row.age && `Age: ${row.age}`, row.country, row.interest]
        .filter(Boolean)
        .forEach((line, i) => {
            if (i) details.append(document.createElement('br'));
            details.append(document.createTextNode(line));
        });
    el.append(details, div('networth', formatMoney(netWorth)));

    // start at a random position; the first transform() flies them into place
    const object = new CSS3DObject(el);
    object.position.set(
        Math.random() * 4000 - 2000,
        Math.random() * 4000 - 2000,
        Math.random() * 4000 - 2000
    );
    return object;
}

/* ======================= Layouts ======================= */

const placeholder = (x = 0, y = 0, z = 0) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    return o;
};

function buildTable(count) {
    const { cols, rows, gapX, gapY } = LAYOUT.table;
    const offsetX = ((cols - 1) * gapX) / 2;
    const offsetY = ((rows - 1) * gapY) / 2;
    return Array.from({ length: count }, (_, i) =>
        placeholder((i % cols) * gapX - offsetX, offsetY - Math.floor(i / cols) * gapY)
    );
}

function buildSphere(count) {
    const vector = new THREE.Vector3();
    return Array.from({ length: count }, (_, i) => {
        const phi = Math.acos(-1 + (2 * i) / count);
        const theta = Math.sqrt(count * Math.PI) * phi;
        const o = new THREE.Object3D();
        o.position.setFromSphericalCoords(LAYOUT.sphere.radius, phi, theta);
        vector.copy(o.position).multiplyScalar(2);
        o.lookAt(vector);
        return o;
    });
}

function buildDoubleHelix(count) {
    const { radius, turn, stepY } = LAYOUT.helix;
    const vector = new THREE.Vector3();
    const height = Math.ceil(count / 2) * stepY;

    return Array.from({ length: count }, (_, i) => {
        const strand = i % 2;                 // alternate tiles between 2 strands
        const step = Math.floor(i / 2);
        const theta = step * turn + strand * Math.PI;  // strands 180° apart
        const y = height / 2 - step * stepY;

        const o = new THREE.Object3D();
        o.position.setFromCylindricalCoords(radius, theta, y);
        vector.set(o.position.x * 2, o.position.y, o.position.z * 2);
        o.lookAt(vector);
        return o;
    });
}

function buildGrid(count) {
    const { cols, rows, gapX, gapY, gapZ } = LAYOUT.grid;
    const perLayer = cols * rows;
    const layers = Math.ceil(count / perLayer);
    const offsetX = ((cols - 1) * gapX) / 2;
    const offsetY = ((rows - 1) * gapY) / 2;
    const offsetZ = ((layers - 1) * gapZ) / 2;

    return Array.from({ length: count }, (_, i) =>
        placeholder(
            (i % cols) * gapX - offsetX,
            offsetY - (Math.floor(i / cols) % rows) * gapY,
            Math.floor(i / perLayer) * gapZ - offsetZ
        )
    );
}

/* ======================= Animation ======================= */

function transform(targetList, name) {
    TWEEN.removeAll();

    objects.forEach((object, i) => {
        const t = targetList[i];
        const duration = Math.random() * TRANSITION_MS + TRANSITION_MS;

        new TWEEN.Tween(object.position)
            .to({ x: t.position.x, y: t.position.y, z: t.position.z }, duration)
            .easing(TWEEN.Easing.Exponential.InOut)
            .start();

        new TWEEN.Tween(object.rotation)
            .to({ x: t.rotation.x, y: t.rotation.y, z: t.rotation.z }, duration)
            .easing(TWEEN.Easing.Exponential.InOut)
            .start();
    });

    // keep re-rendering while the tweens run
    new TWEEN.Tween({}).to({}, TRANSITION_MS * 2).onUpdate(render).start();

    LAYOUT_NAMES.forEach((n) => $(n).classList.toggle('active', n === name));
}

function render() {
    renderer.render(scene, camera);
}

function animate() {
    requestAnimationFrame(animate);
    TWEEN.update();
    controls.update();
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    render();
}

/* ======================= Scene setup ======================= */

function initScene(rows) {
    camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 1, 12000);
    camera.position.z = 3500;

    scene = new THREE.Scene();

    rows.forEach((row, i) => {
        const tile = createTile(row, i);
        scene.add(tile);
        objects.push(tile);
    });

    const count = objects.length;
    targets.table = buildTable(count);
    targets.sphere = buildSphere(count);
    targets.helix = buildDoubleHelix(count);
    targets.grid = buildGrid(count);

    renderer = new CSS3DRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    $('container').appendChild(renderer.domElement);

    controls = new TrackballControls(camera, renderer.domElement);
    controls.minDistance = 500;
    controls.maxDistance = 8000;
    controls.addEventListener('change', render);

    LAYOUT_NAMES.forEach((name) =>
        $(name).addEventListener('click', () => transform(targets[name], name))
    );

    window.addEventListener('resize', onResize);

    transform(targets.table, 'table');
    animate();
}

/* ======================= Boot ======================= */

async function onLoggedIn() {
    try {
        setStatus('Loading data...');
        const rows = await fetchRows();
        if (!rows.length) throw new Error('The sheet has no data rows.');

        $('login').hidden = true;
        $('menu').hidden = false;
        $('legend').hidden = false;
        initScene(rows);
    } catch (err) {
        console.error(err);
        setStatus(err.message);
    }
}

async function boot() {
    try {
        await waitForGoogle();
        const tokenClient = createTokenClient(onLoggedIn);
        const signIn = $('signin');
        signIn.disabled = false;
        signIn.addEventListener('click', () => tokenClient.requestAccessToken());
    } catch (err) {
        setStatus(err.message);
    }
}

boot();