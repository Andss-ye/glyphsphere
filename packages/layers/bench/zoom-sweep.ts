/**
 * Coste por capa a lo largo de un descenso continuo. Busca **discontinuidades**, no el peor caso:
 * un pico entre dos altitudes vecinas es un umbral mal puesto, y es lo que se siente como que el
 * frame "sube de la nada".
 *
 *   CITY=bogota pnpm --filter @glyphsphere/layers exec tsx bench/zoom-sweep.ts
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  Grid,
  LayerStack,
  buildProjection,
  createCameraState,
  createSampleBuffer,
  createSampleContext,
  createViewMetrics,
  paintBodySilhouette,
  reduce,
} from '@glyphsphere/core';
import { earth } from '@glyphsphere/bodies';
import {
  decodeHeightmap,
  decodeStreets,
  defaultLayers,
  parseLandTopology,
  type StreetsMeta,
} from '@glyphsphere/layers';

const A = new URL('../../data/assets/earth/', import.meta.url).pathname;
const j = (f: string) => JSON.parse(readFileSync(`${A}${f}`, 'utf8'));
const gz = (f: string) => JSON.parse(gunzipSync(readFileSync(`${A}${f}`)).toString());

const land = parseLandTopology(j('land-10m.topo.json'), 'land');
const heightmap = decodeHeightmap(
  new Uint8Array(gunzipSync(readFileSync(`${A}relief-etopo1.bin.gz`))),
  j('relief.json'),
);
const rivers = gz('rivers-10m.geojson.gz');
const lakes = gz('lakes-10m.geojson.gz');
const roads = gz('roads-10m.geojson.gz');
const urbanAreas = gz('urban-areas-10m.geojson.gz');
const meta = j('streets.json') as StreetsMeta;
const tiles = meta.tiles.map((t) =>
  decodeStreets(new Uint8Array(gunzipSync(readFileSync(`${A}${t.file}`))), meta, t),
);

const COLS = 200;
const ROWS = 60;
const N = 12;
const view = createViewMetrics(COLS, ROWS);
const grid = new Grid(COLS, ROWS);
const buffer = createSampleBuffer(COLS, ROWS);
const stack = new LayerStack(
  defaultLayers(earth, { land, heightmap, rivers, lakes, roads, urbanAreas, streets: tiles }),
);

const WHERE = process.env.CITY ?? 'bogota';
const t = meta.tiles.find((x) => x.id === WHERE)!;
const lon = (t.bbox[0] + t.bbox[2]) / 2;
const lat = (t.bbox[1] + t.bbox[3]) / 2;

// Ladder geométrica: cada peldaño es ~1.6x, así que un salto real destaca sobre el crecimiento suave.
const ALTS = [400, 250, 150, 90, 55, 34, 20, 13, 8, 5, 3, 2, 1.2, 0.8, 0.5, 0.3, 0.2];

const ids = new Set<string>();
for (const alt of ALTS) {
  const camera = createCameraState(earth.id, { lon, lat, altitudeKm: alt });
  for (const layer of stack.active(camera, earth, 'geometry')) ids.add(layer.id);
}
const columns = [...ids];

console.log(`=== ${t.name} · rejilla ${COLS}x${ROWS} ===`);
console.log(
  ['altKm', 'm/celda', ...columns.map((c) => c.slice(0, 9)), 'reduce', 'TOTAL']
    .map((h) => h.padStart(9))
    .join(''),
);

for (const altitudeKm of ALTS) {
  const camera = createCameraState(earth.id, { lon, lat, altitudeKm });
  const projection = buildProjection(earth, camera, view);
  const ctx = createSampleContext(buffer, projection, earth, camera);
  const active = new Map([...stack.active(camera, earth, 'geometry')].map((l) => [l.id, l]));

  const cells: string[] = [];
  let total = 0;
  for (const id of columns) {
    const layer = active.get(id);
    if (!layer) {
      cells.push('·'.padStart(9));
      continue;
    }
    buffer.clear();
    paintBodySilhouette(buffer, projection);
    for (let i = 0; i < 3; i++) layer.paint?.(ctx, earth);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) layer.paint?.(ctx, earth);
    const ms = (performance.now() - t0) / N;
    total += ms;
    cells.push(ms.toFixed(2).padStart(9));
  }

  buffer.clear();
  paintBodySilhouette(buffer, projection);
  for (const layer of active.values()) layer.paint?.(ctx, earth);
  for (let i = 0; i < 3; i++) reduce(buffer, grid, earth);
  const t1 = performance.now();
  for (let i = 0; i < N; i++) reduce(buffer, grid, earth);
  const rms = (performance.now() - t1) / N;
  total += rms;

  console.log(
    [
      String(altitudeKm),
      projection.metersPerCell().toFixed(0),
      ...cells.map((c) => c.trim()),
      rms.toFixed(2),
      total.toFixed(2),
    ]
      .map((c) => c.padStart(9))
      .join(''),
  );
}
