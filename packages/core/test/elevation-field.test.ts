import { describe, expect, it } from 'vitest';
import { createSampleContext, paintBodySilhouette } from '../src/layers/types.js';
import { createSampleBuffer } from '../src/raster/sample-buffer.js';
import { buildProjection } from '../src/projection/satellite.js';
import { createViewMetrics } from '../src/projection/aspect.js';
import { createCameraState } from '../src/camera/state.js';
import { testBody } from './fixtures.js';

/**
 * `fillElevationField` is the single most expensive thing in a frame — it is the only stage that
 * touches every subcell — so its work has to be exactly the work required, and nothing above it.
 */

const COLS = 60;
const ROWS = 24;
const body = testBody();

function fieldRun(altitudeKm: number) {
  const view = createViewMetrics(COLS, ROWS);
  const camera = createCameraState(body.id, { lon: 10, lat: -5, altitudeKm });
  const projection = buildProjection(body, camera, view);
  const buffer = createSampleBuffer(COLS, ROWS);

  buffer.clear();
  paintBodySilhouette(buffer, projection);

  let onBody = 0;
  for (const value of buffer.bodyMask) if (value !== 0) onBody++;

  const seen = new Set<number>();
  let calls = 0;
  const ctx = createSampleContext(buffer, projection, body, camera);
  ctx.fillElevationField((lon, lat) => {
    calls++;
    // A metre per degree of latitude: a smooth field, so any interpolation is legitimate and
    // the assertions below are about *how many* samples happen, not which value comes back.
    return lat;
  });

  // Which subcells actually received a value, counted from the buffer rather than the callback.
  for (let i = 0; i < buffer.elevation.length; i++) {
    if (buffer.bodyMask[i] !== 0) seen.add(i);
  }

  return { onBody, calls, written: seen.size, buffer };
}

describe('fillElevationField', () => {
  it.each([80_000, 20_000, 2_000, 150, 1])(
    'samples each on-body subcell exactly once at %i km',
    (altitudeKm) => {
      const { onBody, calls } = fieldRun(altitudeKm);

      expect(onBody).toBeGreaterThan(0);
      /**
       * Regression guard. Spans share an endpoint so the inverse projection can be carried from
       * one to the next, and that overlap used to be *written* as well as interpolated — every
       * span boundary got sampled twice, 114 408 samples for 101 808 subcells on a real frame.
       * Sampling is the frame's hot path; a duplicate is pure waste.
       */
      expect(calls).toBe(onBody);
    },
  );

  it('never samples a subcell that is off the body', () => {
    // At high altitude the body does not fill the frame, so this is a real constraint: inverting
    // off-disc coordinates is wasted work and there is no ground there to have a height.
    const { onBody, calls, buffer } = fieldRun(80_000);
    expect(onBody).toBeLessThan(buffer.width * buffer.height);
    expect(calls).toBe(onBody);
  });

  it('leaves the elevation of off-body subcells untouched', () => {
    const { buffer } = fieldRun(80_000);
    for (let i = 0; i < buffer.elevation.length; i++) {
      if (buffer.bodyMask[i] === 0) expect(buffer.elevation[i]).toBe(0);
    }
  });

  /**
   * The whole optimisation rests on one claim: interpolating lon/lat between span endpoints is
   * *indistinguishable* from un-projecting every subcell. This checks the claim directly, against
   * a reference built one exact inverse projection at a time.
   *
   * It matters more since the span became limb-aware — off-screen-limb frames interpolate across
   * 64 subcells at a stretch, eight times further than before.
   */
  it.each([80_000, 20_000, 2_000, 150, 1])(
    'matches an exactly un-projected field at %i km',
    (altitudeKm) => {
      const view = createViewMetrics(COLS, ROWS);
      const camera = createCameraState(body.id, { lon: 10, lat: -5, altitudeKm });
      const projection = buildProjection(body, camera, view);

      // Degrees scaled up so a disagreement survives the Int16 the buffer stores.
      const field = (lon: number, lat: number): number => Math.round(lat * 100 + lon * 10);

      const buffer = createSampleBuffer(COLS, ROWS);
      buffer.clear();
      paintBodySilhouette(buffer, projection);
      createSampleContext(buffer, projection, body, camera).fillElevationField(field);

      let compared = 0;
      let worst = 0;
      for (let sy = 0; sy < buffer.height; sy++) {
        for (let sx = 0; sx < buffer.width; sx++) {
          const index = sy * buffer.width + sx;
          if (buffer.bodyMask[index] === 0) continue;

          const exact = projection.fromCell([
            (sx + 0.5) / buffer.subX,
            (sy + 0.5) / buffer.subY,
          ]);
          if (!exact) continue;

          compared++;
          worst = Math.max(worst, Math.abs(buffer.elevation[index]! - field(exact[0], exact[1])));
        }
      }

      expect(compared).toBeGreaterThan(100);
      // Half a subcell of latitude is the stated tolerance; at 100 units per degree over a grid
      // this coarse that is comfortably inside 100 units.
      expect(worst).toBeLessThan(100);
    },
  );

  it('covers the on-body subcells: no gap at a span boundary', () => {
    // The half-open write is only correct if the spans still tile the row. A gap would leave a
    // subcell at its cleared value, which reads as sea level and would draw water on a mountain.
    const { buffer } = fieldRun(150);
    let onBody = 0;
    let zeroed = 0;
    for (let i = 0; i < buffer.elevation.length; i++) {
      if (buffer.bodyMask[i] === 0) continue;
      onBody++;
      // The field returns latitude, which is 0 only along the equator; the camera sits at -5.
      if (buffer.elevation[i] === 0) zeroed++;
    }
    expect(onBody).toBeGreaterThan(0);
    expect(zeroed / onBody).toBeLessThan(0.05);
  });
});
