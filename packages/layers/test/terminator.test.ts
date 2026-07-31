import { describe, expect, it } from 'vitest';
import {
  Grid,
  PAL,
  buildProjection,
  createCameraState,
  createViewMetrics,
  solarIncidence,
  subsolarPoint,
} from '@glyphsphere/core';
import { earth } from '@glyphsphere/bodies';
import { terminatorLayer } from '../src/index.js';

/**
 * Night has to stay a *map*.
 *
 * The layer used to swap every night cell to one NIGHT index. The glyphs survived, but at
 * planetary zoom `,` and `·` are both small marks and it was colour that told land from sea —
 * so whole regions read as ocean the moment they turned into the dark. Rotating the globe was
 * enough to trigger it, which is exactly how it was reported: "Chile, Central America and
 * Colombia suddenly look like water".
 */

const view = createViewMetrics(120, 40);

/** Noon over the Pacific, so the Americas sit in daylight and Asia in night. */
const AT = new Date('2024-03-20T20:00:00Z');

function paintAt(fg: number, lon: number, lat: number, altitudeKm = 20_000) {
  const camera = createCameraState(earth.id, { lon, lat, altitudeKm });
  const projection = buildProjection(earth, camera, view);
  const grid = new Grid(120, 40);

  // Fill every on-body cell with the same glyph and palette index, then let the layer run.
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      if (projection.fromCell([x + 0.5, y + 0.5])) grid.set(x, y, 0x2e, fg);
    }
  }

  terminatorLayer({ at: () => AT }).draw!(grid, camera, projection, earth);
  return { grid, projection };
}

/** The palette index the layer left at a given lon/lat. */
function indexAt(fg: number, centreLon: number, lon: number, lat: number): number {
  const { grid, projection } = paintAt(fg, centreLon, 0);
  const cell = projection.toCell([lon, lat]);
  if (!cell) throw new Error('point is not on screen');
  return grid.get(Math.round(cell[0]), Math.round(cell[1])).fg;
}

describe('the night side stays readable', () => {
  it('land and water take different tones after dark', () => {
    // Central Asia, deep in night at this instant.
    const asLand = indexAt(PAL.PLAIN, 90, 90, 45);
    const asWater = indexAt(PAL.PELAGIC, 90, 90, 45);

    expect(asLand).not.toBe(asWater);
    expect(asWater).toBe(PAL.NIGHT);
    expect(asLand).toBe(PAL.NIGHTLIT);
  });

  it('every water band collapses to the same night tone, and no land band joins them', () => {
    for (const water of [PAL.ABYSS, PAL.PELAGIC, PAL.SHELF]) {
      expect(indexAt(water, 90, 90, 45)).toBe(PAL.NIGHT);
    }
    for (const land of [PAL.LITTORAL, PAL.PLAIN, PAL.STEPPE, PAL.HIGHLAND, PAL.ALPINE, PAL.SNOW]) {
      expect(indexAt(land, 90, 90, 45)).not.toBe(PAL.NIGHT);
    }
  });

  it('leaves the daylight side alone', () => {
    // Directly under the sun at this instant: 120 W, near the equator.
    expect(indexAt(PAL.PLAIN, -120, -120, 0)).toBe(PAL.PLAIN);
    expect(indexAt(PAL.PELAGIC, -120, -120, 0)).toBe(PAL.PELAGIC);
  });

  it('borders and instrument colours dim rather than vanish', () => {
    // CHROME is not a band index, so it is treated as standing above the sea.
    expect(indexAt(PAL.CHROME, 90, 90, 45)).toBe(PAL.NIGHTLIT);
  });

  it('a body with no water gives its whole night side the land tone', () => {
    const moonish = { ...earth, hasHydrosphere: false, bands: earth.bands.filter((b) => b.maxM > 0) };
    const camera = createCameraState(earth.id, { lon: 90, lat: 0, altitudeKm: 20_000 });
    const projection = buildProjection(moonish, camera, view);
    const grid = new Grid(120, 40);
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        if (projection.fromCell([x + 0.5, y + 0.5])) grid.set(x, y, 0x2e, PAL.PLAIN);
      }
    }
    terminatorLayer({ at: () => AT }).draw!(grid, camera, projection, moonish);

    const cell = projection.toCell([90, 45])!;
    expect(grid.get(Math.round(cell[0]), Math.round(cell[1])).fg).toBe(PAL.NIGHTLIT);
  });
});

describe('the terminator sits where the sun puts it', () => {
  it('the band is centred on the real subsolar meridian, not on clock noon', () => {
    // At 12:00 UTC in early November the real sun is 4.1 deg east of Greenwich.
    const november = subsolarPoint(new Date('2024-11-03T12:00:00Z'), earth);
    expect(november.lon).toBeCloseTo(-4.1, 0);

    // In mid-April it is on it.
    const april = subsolarPoint(new Date('2024-04-15T12:00:00Z'), earth);
    expect(Math.abs(april.lon)).toBeLessThan(0.5);
  });
});

/**
 * The layer evaluates solar incidence every few cells and interpolates between, because
 * un-projecting is the cost and it used to do it once per cell — 12 726 inverse projections a
 * frame on a 202x63 grid, most of them to conclude "full daylight, leave it".
 *
 * That is only allowed if the picture is the same. This rebuilds the frame the slow, exact way
 * and demands it match.
 */
describe('interpolating incidence does not move the terminator', () => {
  function exactFrame(fg: number, lon: number, lat: number, altitudeKm: number, bandWidth = 0.06) {
    const camera = createCameraState(earth.id, { lon, lat, altitudeKm });
    const projection = buildProjection(earth, camera, view);
    const grid = new Grid(view.cols, view.rows);
    const sun = subsolarPoint(AT, earth);
    const waterIndices = new Set(
      earth.bands.filter((band) => band.maxM <= 0).map((band) => band.paletteIndex),
    );

    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        const lonLat = projection.fromCell([x + 0.5, y + 0.5]);
        if (!lonLat) continue;
        grid.set(x, y, 0x2e, fg);

        const incidence = solarIncidence(lonLat, sun);
        if (incidence > bandWidth) continue;
        const water = waterIndices.has(fg);
        grid.set(
          x,
          y,
          0x2e,
          incidence > -bandWidth
            ? water
              ? PAL.NIGHTLIT
              : PAL.ALPINE
            : water
              ? PAL.NIGHT
              : PAL.NIGHTLIT,
        );
      }
    }
    return grid;
  }

  it.each([
    ['globo', 0, 0, 20_000],
    ['limbo en cuadro', 140, 20, 6_000],
    ['regional', -74, 4.6, 150],
    ['barrio', 100, 35, 1],
  ] as const)('matches an exactly evaluated frame: %s', (_name, lon, lat, altitudeKm) => {
    const fg = PAL.PLAIN;
    const { grid: fast } = paintAt(fg, lon, lat, altitudeKm);
    const slow = exactFrame(fg, lon, lat, altitudeKm);

    let differing = 0;
    let painted = 0;
    for (let y = 0; y < view.rows; y++) {
      for (let x = 0; x < view.cols; x++) {
        const a = fast.get(x, y);
        const b = slow.get(x, y);
        if (a.glyph === 0 && b.glyph === 0) continue;
        painted++;
        if (a.fg !== b.fg) differing++;
      }
    }

    expect(painted).toBeGreaterThan(50);
    // Exact agreement is the bar: the fallback to per-cell evaluation is triggered by exactly
    // the spans where interpolation would have moved anything.
    expect(differing).toBe(0);
  });
});
