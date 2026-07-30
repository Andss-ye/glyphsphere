import {
  Camera,
  Grid,
  LayerStack,
  LodTracker,
  NavigationController,
  buildProjection,
  clampToAvailable,
  createCameraState,
  createPipeline,
  createViewMetrics,
  lodForAltitude,
  lodIndex,
  singleBodyScene,
  solarScreenDirection,
  subsolarPoint,
  type LodLevel,
  type Projection,
} from '@glyphsphere/core';
import { earth } from '@glyphsphere/bodies';
import {
  cityLabels,
  defaultLayers,
  loadHeightmap,
  loadPlaces,
  createOnlineStreetSource,
  loadStreetTile,
  parseLandTopology,
  tileAt,
  type Heightmap,
  type LandTopology,
  type Places,
  type StreetTile,
  type StreetsMeta,
} from '@glyphsphere/layers';
import { mesh } from 'topojson-client';
import type { FeatureCollection, Geometry, MultiLineString } from 'geojson';
import reliefMeta from '@glyphsphere/data/assets/earth/relief.json';
import reliefUrl from '@glyphsphere/data/assets/earth/relief-etopo1.bin.gz?url';
import placesMeta from '@glyphsphere/data/assets/earth/places.json';
import placesUrl from '@glyphsphere/data/assets/earth/places-10m.bin.gz?url';
import riversUrl from '@glyphsphere/data/assets/earth/rivers-10m.geojson.gz?url';
import lakesUrl from '@glyphsphere/data/assets/earth/lakes-10m.geojson.gz?url';
import roadsUrl from '@glyphsphere/data/assets/earth/roads-10m.geojson.gz?url';
import urbanAreasUrl from '@glyphsphere/data/assets/earth/urban-areas-10m.geojson.gz?url';
import streetsMeta from '@glyphsphere/data/assets/earth/streets.json';

/**
 * Los tiles de calles se resuelven por nombre porque el manifiesto los nombra: Vite necesita ver
 * el glob para incluirlos en el build, y así agregar una ciudad al build de datos no obliga a
 * tocar el playground.
 */
const STREET_URLS = import.meta.glob('../../../packages/data/assets/earth/streets/*.bin.gz', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
import { CanvasRenderer } from '@glyphsphere/renderer-canvas';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { applyRegisterOverlay, registerCounts } from './panels/registers.js';
import { Hud, keyHints } from './panels/hud.js';
import { LabelOverlay } from './overlay.js';
import { bindNavigation } from './input.js';

/**
 * Fase 3 "hecho cuando": se va del planeta entero a un país arrastrando y haciendo zoom, sin
 * saltos, sin parpadeos de LOD, y el ventilador no se enciende al soltar el mouse.
 */
const CELL_PX = 14;

/** Loaded on demand: the L2+ file is 10x the L0 one, and most sessions never need it. */
const LAND_SOURCES: Partial<Record<LodLevel, () => Promise<Topology>>> = {
  L0: () => import('@glyphsphere/data/assets/earth/land-110m.topo.json').then((m) => m.default as never),
  L1: () => import('@glyphsphere/data/assets/earth/land-110m.topo.json').then((m) => m.default as never),
  L2: () => import('@glyphsphere/data/assets/earth/land-50m.topo.json').then((m) => m.default as never),
  L3: () => import('@glyphsphere/data/assets/earth/land-50m.topo.json').then((m) => m.default as never),
  L4: () => import('@glyphsphere/data/assets/earth/land-10m.topo.json').then((m) => m.default as never),
};

/**
 * docs/RELIEF.md names Andes, Himalaya and Sognefjord as the calibration views; the rest are
 * cities, which double as the Fase 5 check that a place is where it belongs.
 *
 * Selecting one *flies* there rather than jumping, which is the point of the arc: crossing the
 * planet takes a moment instead of fifty wheel notches.
 */
/**
 * Altitudes recalibradas para el campo de visión. Las de antes estaban elegidas contra un
 * encuadre que seguía al horizonte, donde 400 km mostraba 14 000 km de terreno; con una lente
 * fija esos mismos 400 km muestran 1 600 km, así que las vistas cercanas bajan de altitud para
 * enmarcar lo que su nombre dice.
 */
const VIEWS = [
  { key: '1', label: 'GLOBO', lon: -30, lat: 20, altitudeKm: 20_000 },
  { key: '2', label: 'ANDES', lon: -70, lat: -30, altitudeKm: 2_500 },
  { key: '3', label: 'HIMALAYA', lon: 86, lat: 30, altitudeKm: 1_500 },
  { key: '4', label: 'SOGNEFJORD', lon: 6.5, lat: 61.2, altitudeKm: 60 },
  { key: '5', label: 'EUROPA', lon: 10, lat: 55, altitudeKm: 4_000 },
  { key: '6', label: 'BOGOTA', lon: -74.07, lat: 4.71, altitudeKm: 30 },
  { key: '7', label: 'TOKIO', lon: 139.69, lat: 35.69, altitudeKm: 30 },
  { key: '8', label: 'NUEVA YORK', lon: -74.0, lat: 40.71, altitudeKm: 30 },
  // Escala de calle: ~20 m por celda. Acá entra la red vial real de OSM, en braille.
  { key: '9', label: 'CALLE', lon: -74.07, lat: 4.65, altitudeKm: 1 },
  { key: '0', label: 'CUADRA', lon: 139.7016, lat: 35.6595, altitudeKm: 0.35 },
] as const;

const canvas = document.querySelector<HTMLCanvasElement>('#glyphsphere');
const overlayRoot = document.querySelector<HTMLElement>('#overlay');
const panelRoot = document.querySelector<HTMLElement>('#panel');
const hintsRoot = document.querySelector<HTMLElement>('#hints');
if (!canvas || !overlayRoot || !panelRoot || !hintsRoot) {
  throw new Error('playground markup is missing #glyphsphere, #overlay, #panel or #hints');
}

const renderer = new CanvasRenderer(canvas, { cellHeightPx: CELL_PX });
const cols = Math.max(80, Math.floor((window.innerWidth - 24) / (CELL_PX * 0.5)));
const rows = Math.max(30, Math.floor((window.innerHeight - 24) / CELL_PX));
renderer.resize(cols, rows);

/**
 * The second design layer: place names in real type, and the instrument panel. The planet
 * itself never leaves the character grid — see apps/playground/src/overlay.ts.
 */
const labelOverlay = new LabelOverlay(overlayRoot, renderer.cellMetrics);
labelOverlay.resize(renderer.cellMetrics, cols, rows);

const view = createViewMetrics(cols, rows, renderer.atlas.aspect);
const grid = new Grid(cols, rows);
const pipeline = createPipeline(cols, rows);
const scene = singleBodyScene(earth);
const stack = new LayerStack(defaultLayers(earth));
const lod = new LodTracker();

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const camera = new Camera(
  earth.id,
  { lon: -30, lat: 20, altitudeKm: 20_000 },
  { reducedMotion: prefersReducedMotion.matches },
);
prefersReducedMotion.addEventListener('change', (event) => {
  camera.reducedMotion = event.matches;
});

const nav = new NavigationController(camera, {
  currentProjection: () => buildProjection(earth, camera.state, view),
  projectionFor: (altitudeKm) =>
    buildProjection(earth, createCameraState(earth.id, { ...camera.state, altitudeKm }), view),
});

// --- Fase 5 data -------------------------------------------------------------------------
let places: Places | null = null;
let borders: MultiLineString | null = null;
let rivers: FeatureCollection<Geometry> | null = null;
let lakes: FeatureCollection<Geometry> | null = null;
let roads: FeatureCollection<Geometry> | null = null;
let urbanAreas: FeatureCollection<Geometry> | null = null;
const streets: StreetTile[] = [];
const streetsRequested = new Set<string>();
let showGraticule = false;

/** Fetches a gzipped GeoJSON asset, decompressing when the server did not. */
async function loadGeoJson(url: string): Promise<FeatureCollection<Geometry>> {
  const response = await fetch(url);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function loadFase5(): Promise<void> {
  // Places first: they are small and they are what the eye looks for.
  places = await loadPlaces(placesUrl, placesMeta);
  rebuildStack();

  const countries = (await import('@glyphsphere/data/assets/earth/countries-50m.topo.json'))
    .default as unknown as Topology;
  // The mesh gives each shared frontier once, instead of twice from two countries' outlines.
  // The filter drops the outer coastline, keeping only frontiers between two countries.
  borders = mesh(
    countries,
    countries.objects.countries as GeometryCollection,
    (a, b) => a !== b,
  );
  rebuildStack();

  [rivers, lakes] = await Promise.all([loadGeoJson(riversUrl), loadGeoJson(lakesUrl)]);
  rebuildStack();
}

// --- Escala urbana ------------------------------------------------------------------------
/**
 * Por demanda: `roads-10m` es el asset vectorial más pesado del set y la mayoría de las sesiones
 * nunca baja de 150 km. Se pide la primera vez que la cámara entra en L4 y no se vuelve a pedir.
 * Como todo lo demás, sale de un archivo horneado — la vista de calle funciona sin red.
 */
let urbanLoading = false;

async function loadUrban(): Promise<void> {
  if (urbanLoading || roads) return;
  urbanLoading = true;
  try {
    [roads, urbanAreas] = await Promise.all([
      loadGeoJson(roadsUrl),
      loadGeoJson(urbanAreasUrl),
    ]);
    rebuildStack();
  } finally {
    urbanLoading = false;
  }
}

// --- Calles reales (OSM) ------------------------------------------------------------------
/**
 * El tile de calles se pide cuando la cámara entra en el bbox de una ciudad y baja de escala
 * urbana — no antes, y solo el que hace falta. Es lo que hace que agregar una ciudad al build de
 * datos no cueste nada en arranque: el manifiesto crece, la descarga sigue siendo una.
 */
const STREETS_ALTITUDE_KM = 25;

/** El manifiesto nombra `streets/<id>.bin.gz`; el glob de Vite indexa por ruta absoluta. */
function streetUrlFor(file: string): string | undefined {
  const name = file.split('/').pop();
  const match = Object.entries(STREET_URLS).find(([path]) => path.endsWith(`/${name}`));
  return match?.[1];
}

/**
 * Cobertura fuera de las ciudades horneadas, **cuando además hay red**.
 *
 * Toda la cortesía con Overpass (una consulta en vuelo, espera creciente, rendición) vive en el
 * origen, no acá: esto se llama una vez por frame y tiene que ser barato y no repetir.
 */
const onlineStreets = createOnlineStreetSource({
  radiusKm: earth.radiusKm,
  maxAltitudeKm: STREETS_ALTITUDE_KM,
  onTile: (tile) => {
    streets.push(tile);
    rebuildStack();
  },
});

async function loadStreetsFor(lon: number, lat: number, altitudeKm: number): Promise<void> {
  if (altitudeKm > STREETS_ALTITUDE_KM) return;

  const meta = streetsMeta as unknown as StreetsMeta;
  const tile = tileAt(meta.tiles, lon, lat);

  // Primero lo horneado, siempre: es el piso garantizado y no depende de nadie.
  if (tile) {
    if (streetsRequested.has(tile.id)) return;
    const url = streetUrlFor(tile.file);
    if (!url) return;

    streetsRequested.add(tile.id);
    streets.push(await loadStreetTile(url, meta, tile));
    rebuildStack();
    return;
  }

  onlineStreets.request(lon, lat, altitudeKm);
}

/**
 * Qué decir en el panel. Distingue las situaciones que el usuario puede resolver de las que no:
 * "sin red" se arregla conectándose, "OSM saturado" se arregla esperando, y "aquí no hay calles"
 * no se arregla.
 */
function streetsStatus(lon: number, lat: number, altitudeKm: number): string {
  if (streets.length > 0) {
    const vias = streets.reduce((n, t) => n + t.roads.length, 0);
    return `${streets.map((t) => t.name).join(', ')}  ${vias} vías`;
  }
  if (tileAt((streetsMeta as unknown as StreetsMeta).tiles, lon, lat)) return 'cargando…';
  if (altitudeKm > STREETS_ALTITUDE_KM) return 'sin datos aquí';

  switch (onlineStreets.status) {
    case 'offline':
      return 'sin datos aquí · sin red';
    case 'fetching':
      return 'consultando OSM…';
    case 'retrying':
      return 'OSM saturado · reintentando';
    case 'unavailable':
      return 'OSM no respondió · se dejó de insistir';
    case 'empty':
      return 'aquí no hay calles en OSM';
    default:
      return 'sin datos aquí';
  }
}

// --- Relief -----------------------------------------------------------------------------
let heightmap: Heightmap | null = null;
const reliefToggles = { bands: true, contours: true, emboss: true, coastalShadow: true };
/** Off by default: relief has to be judged in daylight, and half the planet never is. */
let showTerminator = false;

/**
 * Deferred on purpose: docs/DATA.md permits showing flat silhouettes for a frame rather than
 * blocking the first paint on the heightmap, which is by far the largest asset.
 */
async function loadRelief(): Promise<void> {
  heightmap = await loadHeightmap(reliefUrl, reliefMeta);
  rebuildStack();
}

// --- LOD-driven geometry loading -------------------------------------------------------
let loadedLevel: LodLevel | null = null;
let wantedLevel: LodLevel | null = null;
let land: LandTopology | null = null;
let loading = false;

/** Rebuilds the stack from whatever data has arrived so far. */
function rebuildStack(): void {
  for (const layer of stack.all.map((l) => l.id)) stack.remove(layer);
  for (const layer of defaultLayers(earth, {
    ...(land ? { land } : {}),
    ...(heightmap && reliefToggles.bands ? { heightmap } : {}),
    ...(borders ? { borders } : {}),
    ...(rivers ? { rivers } : {}),
    ...(lakes ? { lakes } : {}),
    ...(roads ? { roads } : {}),
    ...(urbanAreas ? { urbanAreas } : {}),
    ...(streets.length > 0 ? { streets } : {}),
    ...(places ? { places } : {}),
    graticule: showGraticule,
  })) {
    if (layer.id === 'terminator' && !showTerminator) continue;
    stack.add(layer);
  }
  pipeline.invalidate();
  requestFrame();
}

/**
 * Loads the land geometry for a level, one load at a time.
 *
 * The request is recorded rather than dropped when a load is already running. Dropping it
 * looks harmless and is not: descending fast enough to cross two rungs while the first file is
 * still in flight left the map showing land-110m at 78 km per cell for the rest of the session,
 * with the panel honestly reporting DETALLE L4 next to GEOMETRIA L0 and no way to recover
 * except crossing the boundary again.
 */
async function loadGeometryFor(level: LodLevel): Promise<void> {
  // La costa más fina que existe offline es land-10m (L4). Por debajo de eso el detalle nuevo no
  // viene de otra costa sino de la capa urbana, que se pide acá y trae su propio dato.
  if (lodIndex(level) >= lodIndex('L4')) void loadUrban();

  // L5+ needs a tile source this build does not have, so the ladder clamps to the deepest
  // dataset that exists. Without the clamp, descending past 150 km asked for a file that is
  // not there and silently kept whatever was already loaded — land-110m at 25 km per cell.
  wantedLevel = clampToAvailable(level, false);
  if (loading) return; // the load in flight will pick this up when it lands

  loading = true;
  try {
    while (wantedLevel !== null && wantedLevel !== loadedLevel) {
      const target = wantedLevel;
      const source = LAND_SOURCES[target];
      if (!source) break;

      land = parseLandTopology(await source(), 'land');
      loadedLevel = target;
      rebuildStack();
    }
  } finally {
    loading = false;
  }
}

// --- Render loop -----------------------------------------------------------------------
let showRegisters = false;
/** Names live in the DOM layer; this hides that layer to judge the character grid alone. */
let showLabels = true;
let frameHandle = 0;
let lastTimestamp = 0;
let lastFrameMs = 0;
/**
 * Lo que cuesta poner la rejilla en pantalla, aparte de lo que cuesta calcularla.
 *
 * Están separados porque medir solo el pipeline escondió el problema durante toda una fase: el
 * panel decía 5 ms mientras el cuadro real costaba diez veces eso en `present`, y el número
 * tranquilizaba en vez de avisar. Un contador que mide media tarea miente.
 */
let lastPresentMs = 0;
let idleFrames = 0;

/**
 * La escala se le pregunta a la proyección, no se recalcula acá: replicar la matemática de
 * cámara es el error que CLAUDE.md marca como el más frecuente del proyecto, y esta función
 * llegó a tener la fórmula vieja — atada al horizonte — sobreviviendo al campo de visión.
 */
function metersPerCellKm(projection: Projection): number {
  return projection.metersPerCell() / 1000;
}

// The panel is declared once and only its values change per frame.
const hud = new Hud(panelRoot);
hud.section(earth.name.toUpperCase(), [
  { id: 'altitude', label: 'Altitud' },
  { id: 'position', label: 'Posición' },
  { id: 'bearing', label: 'Rumbo' },
  { id: 'scale', label: 'Escala' },
]);
hud.section('Datos', [
  { id: 'lod', label: 'Detalle' },
  { id: 'geometry', label: 'Geometría' },
  { id: 'relief', label: 'Relieve' },
  { id: 'urban', label: 'Urbano' },
  { id: 'streets', label: 'Calles' },
  { id: 'places', label: 'Lugares' },
  { id: 'labels', label: 'Etiquetas' },
]);
hud.section('Cuadro', [
  { id: 'frame', label: 'Coste' },
  { id: 'idle', label: 'Reposo' },
]);
hud.meters('Registros', [
  { id: 'braille', label: 'Braille' },
  { id: 'quadrant', label: 'Cuadrante' },
  { id: 'directional', label: 'Direccional' },
  { id: 'semantic', label: 'Semántico' },
]);

keyHints(hintsRoot, [
  ['Arrastrar', 'girar'],
  ['Rueda', 'zoom'],
  ['⇧ Rueda', 'zoom rápido'],
  ['Doble clic', 'acercar'],
  ['1-0', 'volar'],
  ['T', 'noche'],
  ['G', 'retícula'],
  ['R', 'registros'],
  ['L', 'nombres'],
  ['B C S M', 'relieve'],
]);

const RELIEF_FLAGS = () =>
  [
    reliefToggles.bands ? 'B' : '·',
    reliefToggles.contours ? 'C' : '·',
    reliefToggles.emboss ? 'S' : '·',
    reliefToggles.coastalShadow ? 'M' : '·',
    showTerminator ? 'T' : '·',
  ].join(' ');

function updateHud(labelCount: number, projection: Projection): void {
  const cam = camera.state;
  const counts = registerCounts(pipeline.registers);

  hud.set('altitude', `${cam.altitudeKm.toFixed(1)} km`);
  hud.set('position', `${cam.lat.toFixed(3)}°, ${cam.lon.toFixed(3)}°`);
  hud.set('bearing', `${cam.bearingDeg.toFixed(1)}°`);
  const kmPerCell = metersPerCellKm(projection);
  // Por debajo de un kilómetro por celda la unidad útil es el metro: es exactamente el rango que
  // el campo de visión abrió, y redondearlo a "0.00 km" lo escondería.
  hud.set(
    'scale',
    kmPerCell >= 1
      ? `${kmPerCell.toFixed(2)} km / celda`
      : `${(kmPerCell * 1000).toFixed(0)} m / celda`,
  );

  hud.set('lod', lod.level ?? '—');
  hud.set('geometry', loadedLevel ?? (loading ? 'cargando…' : 'ninguna'));
  hud.set('relief', heightmap ? `ETOPO1  ${RELIEF_FLAGS()}` : 'cargando…');
  hud.set('streets', streetsStatus(cam.lon, cam.lat, cam.altitudeKm));
  hud.set(
    'urban',
    roads
      ? `${roads.features.length} vías${cam.altitudeKm <= 150 ? '' : ' (fuera de escala)'}`
      : urbanLoading
        ? 'cargando…'
        : 'sobre 150 km',
  );
  hud.set('places', places ? `${places.forLod(lod.level ?? 'L0').length}` : 'cargando…');
  hud.set('labels', showLabels ? `${labelCount}` : 'ocultas');

  hud.set(
    'frame',
    `${lastFrameMs.toFixed(1)} + ${lastPresentMs.toFixed(1)} ms  ${pipeline.usedCache ? 'caché' : 'pintado'}`,
  );
  // The budget in CLAUDE.md is 10 ms of CPU; flag the frame the moment it stops fitting.
  hud.flag('frame', lastFrameMs + lastPresentMs > 16);
  hud.set('idle', camera.isSettled ? `sí, ${idleFrames} omitidos` : 'no');

  const total = counts.total || 1;
  for (const id of ['braille', 'quadrant', 'directional', 'semantic'] as const) {
    const fraction = counts[id]! / total;
    hud.meter(id, fraction, `${(fraction * 100).toFixed(1)} %`);
  }
  /**
   * docs/AESTHETIC.md: braille is fine detail, never wallpaper — it has to stay a clear
   * minority. Flagged past half, not earlier: Europe at 3000 km legitimately reaches 44 %
   * (19 coast, 7 borders, 8 contours, 4 hydro) and flagging the densest honest view on the
   * planet would just teach you to ignore the colour.
   */
  hud.flag('braille', counts.braille! / total > 0.5);
}

function renderOnce(dtMs: number, timestampMs: number): void {
  camera.update(dtMs);

  const changed = lod.update(camera.state.altitudeKm);
  if (changed) void loadGeometryFor(changed);

  // Las calles siguen a la cámara, no al LOD: dependen de *dónde* está, no solo de cuán bajo.
  void loadStreetsFor(camera.state.lon, camera.state.lat, camera.state.altitudeKm);

  // The light comes from the real solar position, so shading agrees with the terminator
  // and the same place looks different at different hours (docs/RELIEF.md).
  const projection = buildProjection(earth, camera.state, view);
  const sun = subsolarPoint(new Date(), earth);
  const [sunX, sunY] = solarScreenDirection(
    sun,
    (lonLat) => projection.toCell(lonLat),
    [camera.state.lon, camera.state.lat],
    view.cellAspect,
  );

  const started = performance.now();
  pipeline.render({
    scene,
    camera: camera.state,
    view,
    grid,
    stack,
    reduce: { relief: { bands: 'auto', emboss: reliefToggles.emboss, sunX, sunY } },
    relief: {
      contours: reliefToggles.contours,
      coastalShadow: reliefToggles.coastalShadow,
      // Resolución de ETOPO1 sobre el terreno. Por debajo de ella los contornos dibujarían la
      // interpolación, no el suelo — y a escala de ciudad taparían las calles, que sí son reales.
      ...(heightmap ? { elevationSourceM: (2 * Math.PI * earth.radiusKm * 1000) / heightmap.width } : {}),
    },
  });
  lastFrameMs = performance.now() - started;

  if (showRegisters) applyRegisterOverlay(grid, pipeline.registers);
  const presentStarted = performance.now();
  renderer.present(grid, pipeline.chrome);
  lastPresentMs = performance.now() - presentStarted;

  // Layer two, after the grid is on screen: names in real type, then the instruments. Neither
  // touches `grid` — that is the whole point of the split.
  const labels =
    showLabels && places
      ? cityLabels({
          places,
          camera: camera.state,
          projection,
          body: earth,
          cols,
          rows,
          measure: labelOverlay.measure,
        })
      : [];
  labelOverlay.draw(labels);

  /**
   * El panel se actualiza a ~8 Hz, no en cada cuadro.
   *
   * Son una veintena de escrituras al DOM, y el DOM no es el lienzo: cada una puede invalidar
   * layout. A 60 fps mientras se arrastra eso es trabajo constante para mostrar números que
   * nadie puede leer tan rápido — el ojo no distingue un contador que cambia 60 veces por
   * segundo de uno que cambia 8.
   */
  if (timestampMs - lastHudMs >= HUD_INTERVAL_MS) {
    lastHudMs = timestampMs;
    updateHud(labels.length, projection);
  }
}

const HUD_INTERVAL_MS = 125;
let lastHudMs = -Infinity;

/**
 * Runs only while something is moving. Once the camera settles the loop stops scheduling
 * frames, which is what "CPU tiende a cero con la cámara quieta" actually means — a static
 * globe must not keep the GPU and the fan awake.
 */
function tick(timestamp: number): void {
  frameHandle = 0;
  const dtMs = lastTimestamp ? Math.min(100, timestamp - lastTimestamp) : 16;
  lastTimestamp = timestamp;

  renderOnce(dtMs, timestamp);

  if (!camera.isSettled || nav.isDragging) {
    idleFrames = 0;
    requestFrame();
  } else {
    idleFrames++;
  }
}

function requestFrame(): void {
  if (frameHandle === 0) frameHandle = requestAnimationFrame(tick);
}

// --- Input ------------------------------------------------------------------------------
const cellFromClient = (clientX: number, clientY: number): [number, number] => {
  const rect = canvas.getBoundingClientRect();
  return [
    ((clientX - rect.left) / rect.width) * cols,
    ((clientY - rect.top) / rect.height) * rows,
  ];
};

bindNavigation(canvas, nav, { toCell: cellFromClient, onChange: requestFrame });

window.addEventListener('keydown', (event) => {
  const preset = VIEWS.find((v) => v.key === event.key);
  if (preset) {
    void camera.flyTo(
      { lon: preset.lon, lat: preset.lat, altitudeKm: preset.altitudeKm },
      earth,
    );
  } else if (event.key === 'r' || event.key === 'R') {
    showRegisters = !showRegisters;
    pipeline.invalidate();
  } else if ('bcsm'.includes(event.key.toLowerCase())) {
    // Each relief technique toggles alone, so its contribution can be judged on its own
    // (docs/RELIEF.md: "Hay una vista en el playground que alterna las cuatro técnicas").
    const key = event.key.toLowerCase();
    if (key === 'b') { reliefToggles.bands = !reliefToggles.bands; rebuildStack(); }
    if (key === 'c') reliefToggles.contours = !reliefToggles.contours;
    if (key === 's') reliefToggles.emboss = !reliefToggles.emboss;
    if (key === 'm') reliefToggles.coastalShadow = !reliefToggles.coastalShadow;
    pipeline.invalidate();
  } else if (event.key === 't' || event.key === 'T') {
    showTerminator = !showTerminator;
    rebuildStack();
  } else if (event.key === 'g' || event.key === 'G') {
    showGraticule = !showGraticule;
    rebuildStack();
  } else if (event.key === 'l' || event.key === 'L') {
    showLabels = !showLabels;
  } else {
    return;
  }
  event.preventDefault();
  requestFrame();
});

/**
 * Debug hook: places the camera exactly, for scripted comparison shots. The playground is a
 * dev tool, so this lives here rather than in any shipped package.
 */
declare global {
  interface Window {
    __glyphsphere?: {
      setView: (lon: number, lat: number, altitudeKm: number) => void;
      state: () => unknown;
    };
  }
}

window.__glyphsphere = {
  setView(lon, lat, altitudeKm) {
    camera.jumpTo({ lon, lat, altitudeKm });
    const level = lodForAltitude(altitudeKm);
    lod.update(altitudeKm);
    if (level !== loadedLevel) void loadGeometryFor(level);
    pipeline.invalidate();
    requestFrame();
  },
  state: () => ({
    camera: camera.state,
    lod: lod.level,
    loadedLevel,
    registers: registerCounts(pipeline.registers),
  }),
};

/**
 * `#lon,lat,altitudeKm` places the camera at load. The same debug affordance as `setView`, but
 * reachable from a URL, which is what makes an automated screenshot of a named view possible.
 */
function applyHashView(): void {
  const parts = window.location.hash.slice(1).split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return;
  window.__glyphsphere?.setView(parts[0]!, parts[1]!, parts[2]!);
}
window.addEventListener('hashchange', applyHashView);

// First geometry load, then draw. Relief arrives on its own schedule.
void loadGeometryFor(lodForAltitude(camera.state.altitudeKm));
void loadRelief();
void loadFase5();
lod.update(camera.state.altitudeKm);
applyHashView();
requestFrame();
