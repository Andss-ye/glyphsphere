/**
 * Escala urbana contra los assets reales: coste por frame y proporción de braille a medida que la
 * cámara baja sobre una ciudad.
 *
 * Las dos cosas importan y se miden juntas a propósito. El presupuesto de CLAUDE.md son 10 ms, y
 * `docs/AESTHETIC.md` pide que el braille sea minoría clara — una capa de calles puede cumplir lo
 * primero dibujando de más y romper lo segundo, que es lo que pasaba con el umbral atado a la
 * altitud en vez de a los metros por celda.
 *
 *   CITY=tokyo ALT=2 pnpm --filter @glyphsphere/layers bench
 *
 * Requiere `pnpm data:build`.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Grid, LayerStack, buildProjection, createCameraState, createPipeline, createViewMetrics, singleBodyScene, REGISTER } from '@glyphsphere/core';
import { earth } from '@glyphsphere/bodies';
import { decodeHeightmap, decodeStreets, defaultLayers, parseLandTopology, tileAt, type StreetsMeta } from '@glyphsphere/layers';

// Relativo al módulo, no al cwd: si no, el bench solo corre desde la raíz del repo.
const A = new URL('../../data/assets/earth/', import.meta.url).pathname;
const j = (f: string) => JSON.parse(readFileSync(`${A}${f}`, 'utf8'));
const gz = (f: string) => JSON.parse(gunzipSync(readFileSync(`${A}${f}`)).toString());

const land = parseLandTopology(j('land-10m.topo.json'), 'land');
const heightmap = decodeHeightmap(new Uint8Array(gunzipSync(readFileSync(`${A}relief-etopo1.bin.gz`))), j('relief.json'));
const rivers = gz('rivers-10m.geojson.gz'), lakes = gz('lakes-10m.geojson.gz');
const roads = gz('roads-10m.geojson.gz'), urbanAreas = gz('urban-areas-10m.geojson.gz');
const meta = j('streets.json') as StreetsMeta;
const elevationSourceM = (2 * Math.PI * earth.radiusKm * 1000) / heightmap.width;

const tiles = meta.tiles.map((t) =>
  decodeStreets(new Uint8Array(gunzipSync(readFileSync(`${A}${t.file}`))), meta, t));
console.log(`streets.json: ${tiles.map((t) => `${t.name} (${t.roads.length} vías, ${t.water.length} agua)`).join(', ')}\n`);

const COLS = 150, ROWS = 40;
const view = createViewMetrics(COLS, ROWS);
const grid = new Grid(COLS, ROWS), pipeline = createPipeline(COLS, ROWS), scene = singleBodyScene(earth);
const stack = new LayerStack(defaultLayers(earth, { land, heightmap, rivers, lakes, roads, urbanAreas, streets: tiles }));
const sinCalles = new LayerStack(defaultLayers(earth, { land, heightmap, rivers, lakes, roads, urbanAreas }));
const sinContornos = new LayerStack(defaultLayers(earth, { land, heightmap, rivers, lakes, roads, urbanAreas, streets: tiles }));

const WHERE = process.env.CITY ?? 'tokyo';
const t = meta.tiles.find((x) => x.id === WHERE)!;
const lon = (t.bbox[0] + t.bbox[2]) / 2, lat = (t.bbox[1] + t.bbox[3]) / 2;
console.log(`tileAt(centro) = ${tileAt(meta.tiles, lon, lat)?.id}\n`);
/**
 * `invalidate()` no es opcional acá: la caché de geometría se indexa por `stack.revision`, y tres
 * LayerStack recién construidos valen todos 0 — sin invalidar, las tres medidas devuelven el mismo
 * frame cacheado y parecen idénticas. (En la app no pasa: el playground reconstruye sobre el mismo
 * stack, así que la revisión sí avanza.)
 */
const brailleDe = (st: LayerStack, alt: number, contornos = true): number => {
  pipeline.invalidate();
  pipeline.render({ scene, camera: createCameraState(earth.id, { lon, lat, altitudeKm: alt }), view, grid, stack: st, relief: { elevationSourceM, contours: contornos } });
  let b = 0; for (const r of pipeline.registers) if (r === REGISTER.BRAILLE) b++;
  return (100 * b) / (COLS * ROWS);
};
// Las dos últimas columnas atribuyen el braille: sin ellas no se sabe si una vista cargada es
// culpa de las calles o de los contornos, que fue justo la confusión que costó más tiempo.
console.log('altKm   m/celda      ms   braille   solo terreno   sin contornos');

for (const alt of [20, 6, 2, 0.6]) {
  const camera = createCameraState(earth.id, { lon, lat, altitudeKm: alt });
  const s: number[] = [];
  for (let i = 0; i < 15; i++) {
    const c = createCameraState(earth.id, { lon: lon + i * 1e-5, lat, altitudeKm: alt });
    pipeline.invalidate();
    const t0 = performance.now();
    pipeline.render({ scene, camera: c, view, grid, stack, relief: { elevationSourceM } });
    s.push(performance.now() - t0);
  }
  s.sort((a, b) => a - b);
  pipeline.invalidate();
  pipeline.render({ scene, camera, view, grid, stack, relief: { elevationSourceM } });
  let br = 0;
  for (const r of pipeline.registers) if (r === REGISTER.BRAILLE) br++;
  const mpc = buildProjection(earth, camera, view).metersPerCell();
  const terreno = brailleDe(sinCalles, alt);
  const calles = brailleDe(sinContornos, alt, false);
  console.log(`${String(alt).padStart(5)}  ${mpc.toFixed(0).padStart(8)}  ${s[7]!.toFixed(2).padStart(6)}  ${(100*br/(COLS*ROWS)).toFixed(1).padStart(6)}%  ${terreno.toFixed(1).padStart(12)}%  ${calles.toFixed(1).padStart(11)}%`);
}

const alt = Number(process.env.ALT ?? 2);
pipeline.render({ scene, camera: createCameraState(earth.id, { lon, lat, altitudeKm: alt }), view, grid, stack, relief: { elevationSourceM } });
console.log(`\n=== ${t.name} a ${alt} km ===`);
for (let y = 0; y < ROWS; y++) {
  let l = '';
  for (let x = 0; x < COLS; x++) { const g = grid.get(x, y).glyph; l += g === 0 ? ' ' : String.fromCodePoint(g); }
  console.log(l.replace(/\s+$/, ''));
}
