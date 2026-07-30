import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Topology } from 'topojson-specification';
import {
  Grid,
  LayerStack,
  buildProjection,
  createPipeline,
  createViewMetrics,
  createCameraState,
  singleBodyScene,
} from '@glyphsphere/core';
import { earth } from '@glyphsphere/bodies';
import { decodeHeightmap, defaultLayers, parseLandTopology } from '../src/index.js';

/**
 * End to end, against the real datasets: does the shoreline land on the right side of each
 * place?
 *
 * The reported bug was that Miami drew as ocean. The cause was in the elevation channel, and
 * `packages/core/test/sea-level.test.ts` pins that unit down. This is the other half: the whole
 * pipeline, the real ETOPO1 grid and the real Natural Earth coastline, asking the only question
 * a person actually asks of a map.
 *
 * It costs a couple of seconds because it decodes an 8 MB heightmap. That is worth it for the
 * one assertion nothing else in the suite can make.
 */

const assets = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'assets',
  'earth',
);

const json = (file: string) => JSON.parse(readFileSync(join(assets, file), 'utf8'));

const land = parseLandTopology(json('land-10m.topo.json') as Topology, 'land');
const heightmap = decodeHeightmap(
  new Uint8Array(gunzipSync(readFileSync(join(assets, 'relief-etopo1.bin.gz')))),
  json('relief.json'),
);

/** The water bands of the Earth profile: everything at or below sea level. */
const WATER_GLYPHS = new Set([' ', '·', '~']);

const COLS = 200;
const ROWS = 60;

/**
 * Judges one place with the camera **centred on it**.
 *
 * The earlier version placed one camera and read every city off that single frame, which quietly
 * coupled this test to how wide the projection frames. It passed only because the framing used to
 * fit the whole visible hemisphere; once the camera gained a field of view, Orlando, New Orleans
 * and Atlanta fell outside the viewport — and `grid.get` returns glyph 0 out of bounds, which
 * `String.fromCodePoint(0 || 32)` turned into a space, which this test reads as water. So three
 * cities off screen reported as "the sea", which is the wrong answer to the right question.
 *
 * Centring per place asks what the test means to ask — is this spot land? — and cannot be moved
 * by a framing change again.
 */
function classifyOne(lon: number, lat: number, altitudeKm: number): 'tierra' | 'agua' {
  const view = createViewMetrics(COLS, ROWS);
  const grid = new Grid(COLS, ROWS);
  const pipeline = createPipeline(COLS, ROWS);
  const stack = new LayerStack(defaultLayers(earth, { land, heightmap }));
  const camera = createCameraState(earth.id, { lon, lat, altitudeKm });

  pipeline.render({ scene: singleBodyScene(earth), camera, view, grid, stack });
  const projection = buildProjection(earth, camera, view);

  const cell = projection.toCell([lon, lat]);
  if (!cell) throw new Error(`${lon},${lat} no proyecta con la cámara centrada en ello`);

  const x = Math.round(cell[0]);
  const y = Math.round(cell[1]);
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) {
    throw new Error(`${lon},${lat} cae fuera del viewport con la cámara centrada en ello`);
  }

  const glyph = String.fromCodePoint(grid.get(x, y).glyph || 32);
  const code = glyph.codePointAt(0)!;

  // Braille means a line runs through the cell — a coast or a contour — which says nothing
  // about which side of the shore the cell is on. Judge those by the ground height instead.
  const isBraille = code >= 0x2800 && code <= 0x28ff;
  return (isBraille ? heightmap.sample(lon, lat) < 0 : WATER_GLYPHS.has(glyph))
    ? 'agua'
    : 'tierra';
}

function classify(
  centre: { altitudeKm: number },
  points: readonly (readonly [string, number, number])[],
): Map<string, 'tierra' | 'agua'> {
  const out = new Map<string, 'tierra' | 'agua'>();
  for (const [name, lon, lat] of points) {
    out.set(name, classifyOne(lon, lat, centre.altitudeKm));
  }
  return out;
}

describe('the Florida coast, at city scale', () => {
  const result = classify({ lon: -81.5, lat: 26.5, altitudeKm: 300 }, [
    ['Miami', -80.19, 25.77],
    ['Orlando', -81.38, 28.54],
    ['Tampa', -82.46, 27.95],
    ['New Orleans', -90.07, 29.95],
    ['Atlanta', -84.39, 33.75],
    ['Golfo de Mexico', -90.0, 25.0],
    ['Atlantico', -72.0, 28.0],
    ['Caribe', -78.0, 20.0],
  ]);

  /** The report that started this: "Miami aparece como agua, lo que está mal." */
  for (const city of ['Miami', 'Orlando', 'Tampa', 'New Orleans', 'Atlanta']) {
    it(`${city} is land`, () => {
      expect(result.get(city)).toBe('tierra');
    });
  }

  for (const sea of ['Golfo de Mexico', 'Atlantico', 'Caribe']) {
    it(`${sea} is water`, () => {
      expect(result.get(sea)).toBe('agua');
    });
  }
});

describe('other low coasts the byte channel used to drown', () => {
  it('the Netherlands and the North Sea stay on their own sides', () => {
    const result = classify({ lon: 5, lat: 52, altitudeKm: 400 }, [
      ['Amsterdam', 4.9, 52.37],
      ['Rotterdam', 4.48, 51.92],
      ['Mar del Norte', 3.0, 55.0],
    ]);
    // Amsterdam is genuinely below sea level; what must not happen is the country vanishing.
    expect(result.get('Rotterdam')).toBe('tierra');
    expect(result.get('Mar del Norte')).toBe('agua');
  });

  it('the Ganges delta is land and the Bay of Bengal is not', () => {
    const result = classify({ lon: 90, lat: 23, altitudeKm: 400 }, [
      ['Dhaka', 90.41, 23.81],
      ['Bahia de Bengala', 89.0, 19.0],
    ]);
    expect(result.get('Dhaka')).toBe('tierra');
    expect(result.get('Bahia de Bengala')).toBe('agua');
  });
});
