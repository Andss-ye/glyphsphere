import { describe, expect, it } from 'vitest';
import { buildProjection } from '../src/projection/satellite.js';
import { createViewMetrics, groundAngleRad, viewportHalfRows } from '../src/projection/aspect.js';
import { cameraDistance, horizonAngleRad } from '../src/projection/visibility.js';
import { createCameraState } from '../src/camera/state.js';
import { smallBody, testBody } from './fixtures.js';

const DEG = 180 / Math.PI;
const view = createViewMetrics(240, 70);

function cameraAt(altitudeKm: number, lon = 0, lat = 0) {
  return createCameraState('test-body', { lon, lat, altitudeKm });
}

/** Radius from the view centre in *row* units, undoing toCell's aspect correction. */
function radiusFromCentreRows(
  cell: readonly [number, number],
  cols: number,
  rows: number,
  cellAspect: number,
): number {
  const dxRows = (cell[0] - cols / 2) * cellAspect;
  const dyRows = cell[1] - rows / 2;
  return Math.hypot(dxRows, dyRows);
}

describe('derivation from docs/CAMERA.md', () => {
  const body = testBody();

  it('camera distance P is 1 + altitude/radius, always > 1', () => {
    expect(cameraDistance(body, 0)).toBe(1);
    expect(cameraDistance(body, body.radiusKm)).toBe(2);
    expect(cameraDistance(body, 400)).toBeCloseTo(1.0627845, 6);
  });

  // docs/CAMERA.md §2 verification: from the ISS an astronaut sees ~2200 km of surface.
  it('at 400 km the horizon is ~19.8 deg, about 2200 km of visible radius', () => {
    const horizonRad = horizonAngleRad(body, 400);
    expect(horizonRad * DEG).toBeCloseTo(19.79, 1);
    expect(horizonRad * body.radiusKm).toBeCloseTo(2200, -2);
  });

  // docs/CAMERA.md §2 verification: the real horizon distance from one kilometre up.
  it('at 1 km the horizon is ~1.01 deg, about 113 km away', () => {
    const horizonRad = horizonAngleRad(body, 1);
    expect(horizonRad * DEG).toBeCloseTo(1.015, 2);
    expect(horizonRad * body.radiusKm).toBeCloseTo(113, 0);
  });

  it('clip angle sits just inside the horizon, to dodge the limb singularity', () => {
    const projection = buildProjection(body, cameraAt(400), view);
    const horizonDeg = horizonAngleRad(body, 400) * DEG;
    expect(projection.clipAngleDeg).toBeLessThan(horizonDeg);
    expect(projection.clipAngleDeg).toBeCloseTo(horizonDeg, 5);
  });

  it('is parametrized by body.radiusKm, not a hard-coded radius', () => {
    // Same altitude, different body: a smaller body curves away faster, so less is visible.
    const big = horizonAngleRad(testBody(), 400);
    const small = horizonAngleRad(smallBody(), 400);
    expect(small).toBeGreaterThan(big);

    // Equal altitude-to-radius ratios must give an identical horizon angle.
    expect(horizonAngleRad(testBody(), 6371)).toBeCloseTo(horizonAngleRad(smallBody(), 1737), 12);
  });
});

/**
 * The camera-to-surface relation the field of view rests on: a ray leaving the camera at `alpha`
 * off the optical axis meets the ground `c` radians from the sub-camera point, with
 * `sin(alpha + c) = P sin(alpha)`.
 */
describe('groundAngleRad', () => {
  const body = testBody();

  it('the optical axis hits the sub-camera point', () => {
    for (const P of [1.001, 1.5, 2, 10]) {
      expect(groundAngleRad(P, 0)).toBeCloseTo(0, 12);
    }
  });

  it('the horizon ray lands on the horizon', () => {
    // alpha_horizon = asin(1/P), and the ground angle there is acos(1/P) — the same horizon the
    // visibility test uses, arrived at from the camera side instead of the tangent side.
    for (const altitudeKm of [1, 400, 6_371, 80_000]) {
      const P = cameraDistance(body, altitudeKm);
      expect(groundAngleRad(P, Math.asin(1 / P))).toBeCloseTo(horizonAngleRad(body, altitudeKm), 9);
    }
  });

  it('never reports ground past the horizon, however wide the ray', () => {
    const P = cameraDistance(body, 400);
    const horizon = horizonAngleRad(body, 400);
    for (const alphaDeg of [0.1, 30, 60, 89.9]) {
      expect(groundAngleRad(P, alphaDeg / DEG)).toBeLessThanOrEqual(horizon + 1e-12);
    }
  });

  it('grows with the angle off axis', () => {
    const P = cameraDistance(body, 400);
    let previous = -1;
    for (const alphaDeg of [0, 0.5, 1, 2, 4]) {
      const c = groundAngleRad(P, alphaDeg / DEG);
      expect(c).toBeGreaterThan(previous);
      previous = c;
    }
  });

  it('reduces to the flat-earth pinhole close in: s = h tan(alpha)', () => {
    // Close to the surface and near the axis, curvature is negligible and the ground distance is
    // just the altitude times the tangent — the relation that makes the scale track altitude.
    const altitudeKm = 2;
    const P = cameraDistance(body, altitudeKm);
    for (const alphaDeg of [1, 5, 10]) {
      const alpha = alphaDeg / DEG;
      const arcKm = groundAngleRad(P, alpha) * body.radiusKm;
      expect(arcKm).toBeCloseTo(altitudeKm * Math.tan(alpha), 2);
    }
  });
});

describe('disc size', () => {
  const body = testBody();

  /**
   * Altitude at which the body stops overflowing the frame and starts fitting inside it:
   * `P = 1/sin(fov/2)`, so `altitude = R * (1/sin(fov/2) - 1)`. With the default 60 degree lens
   * that is exactly one body radius.
   */
  const crossoverKm = body.radiusKm * (1 / Math.sin(view.fovDeg / 2 / DEG) - 1);

  /** Where the limb lands, in row units from the view centre. */
  function limbRadiusRows(altitudeKm: number): number {
    const projection = buildProjection(body, cameraAt(altitudeKm), view);
    // Camera sits at (0,0), so a point at lon = c is exactly c degrees away along the equator.
    const cell = projection.toCell([projection.clipAngleDeg * 0.99999, 0]);
    expect(cell).not.toBeNull();
    return radiusFromCentreRows(cell!, view.cols, view.rows, view.cellAspect);
  }

  // Above the crossover the body fits the frame, and the original Fase 1 criterion still holds
  // exactly: the limb touches the viewport edge.
  it.each([20_000, 80_000])('puts the limb at the viewport edge at %i km', (altitudeKm) => {
    expect(altitudeKm).toBeGreaterThan(crossoverKm);
    expect(limbRadiusRows(altitudeKm)).toBeCloseTo(viewportHalfRows(view), 2);
  });

  // Below it the lens is narrower than the horizon, so the limb is off screen. That is the whole
  // point of the field of view: the frame stops chasing the horizon and starts holding a scale.
  it.each([0.5, 5, 400, 2_000])('puts the limb beyond the viewport at %i km', (altitudeKm) => {
    expect(altitudeKm).toBeLessThan(crossoverKm);
    expect(limbRadiusRows(altitudeKm)).toBeGreaterThan(viewportHalfRows(view));
  });

  it('reports where the limb is, at every altitude', () => {
    for (const altitudeKm of [0.5, 5, 400, 2_000, 20_000, 80_000]) {
      const projection = buildProjection(body, cameraAt(altitudeKm), view);
      expect(limbRadiusRows(altitudeKm)).toBeCloseTo(projection.radiusRows, 2);
    }
  });

  it('the limb closes in monotonically as the camera climbs', () => {
    const radii = [0.5, 5, 400, 2_000, 20_000, 80_000].map(limbRadiusRows);
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]!).toBeLessThanOrEqual(radii[i - 1]! + 1e-6);
    }
    // And it never shrinks past the viewport: the body cannot be framed smaller than it is.
    expect(Math.min(...radii)).toBeCloseTo(viewportHalfRows(view), 2);
  });

  it('the framing is continuous across the crossover — no jump in scale', () => {
    /**
     * At the crossover the viewport edge ray is exactly tangent to the horizon, which is where
     * `asin` has a vertical tangent — so the *slope* of the scale changes abruptly while the
     * *value* does not. Testing it at a fixed step would therefore measure the kink, not a jump.
     * Continuity is the statement that the two sides converge as the step shrinks, so that is
     * what gets asserted.
     */
    const gap = (eps: number): number => {
      const below = buildProjection(body, cameraAt(crossoverKm * (1 - eps)), view).metersPerCell();
      const above = buildProjection(body, cameraAt(crossoverKm * (1 + eps)), view).metersPerCell();
      return Math.abs(1 - below / above);
    };

    const coarse = gap(1e-3);
    const fine = gap(1e-9);
    expect(fine).toBeLessThan(coarse);
    expect(fine).toBeLessThan(0.01);
  });

  it('the view centre projects to the centre of the grid', () => {
    const projection = buildProjection(body, cameraAt(2_000, -74.07, 4.71), view);
    const cell = projection.toCell([-74.07, 4.71]);
    expect(cell![0]).toBeCloseTo(view.cols / 2, 9);
    expect(cell![1]).toBeCloseTo(view.rows / 2, 9);
  });

  it('corrects for cell aspect, so the disc is round and not oval', () => {
    const projection = buildProjection(body, cameraAt(20_000), view);
    const east = projection.toCell([projection.clipAngleDeg * 0.9, 0])!;
    const north = projection.toCell([0, projection.clipAngleDeg * 0.9])!;

    const horizontalRows = (east[0] - view.cols / 2) * view.cellAspect;
    const verticalRows = view.rows / 2 - north[1];
    expect(horizontalRows).toBeCloseTo(verticalRows, 6);

    // In raw cell units the horizontal extent is 1/aspect times wider -- that is the squash
    // the correction exists to undo.
    expect(east[0] - view.cols / 2).toBeCloseTo(verticalRows / view.cellAspect, 6);
  });
});

describe('toCell / fromCell round-trip', () => {
  const body = testBody();

  it.each([
    ['globe view', 20_000],
    ['regional', 2_000],
    ['low orbit', 400],
    ['street level', 0.5],
  ])('is exact in %s', (_label, altitudeKm) => {
    const cam = cameraAt(altitudeKm, -74.07, 4.71);
    const projection = buildProjection(body, cam, view);
    const horizonDeg = horizonAngleRad(body, altitudeKm) * DEG;

    // Sample points well inside the visible cap, spread around the centre.
    for (const dLon of [-0.6, -0.2, 0, 0.3, 0.7]) {
      for (const dLat of [-0.5, 0, 0.4]) {
        const lonLat: [number, number] = [
          cam.lon + dLon * horizonDeg,
          cam.lat + dLat * horizonDeg,
        ];
        const cell = projection.toCell(lonLat);
        expect(cell).not.toBeNull();

        const back = projection.fromCell(cell!);
        expect(back).not.toBeNull();
        expect(back![0]).toBeCloseTo(lonLat[0], 6);
        expect(back![1]).toBeCloseTo(lonLat[1], 6);
      }
    }
  });

  it('survives a non-zero bearing', () => {
    const cam = createCameraState('test-body', {
      lon: 139.69,
      lat: 35.69,
      altitudeKm: 3_000,
      bearingDeg: 37,
    });
    const projection = buildProjection(body, cam, view);
    const lonLat: [number, number] = [141, 37];

    const back = projection.fromCell(projection.toCell(lonLat)!);
    expect(back![0]).toBeCloseTo(lonLat[0], 6);
    expect(back![1]).toBeCloseTo(lonLat[1], 6);
  });

  it('fromCell returns null for a cell off the body', () => {
    const projection = buildProjection(body, cameraAt(20_000), view);
    expect(projection.fromCell([0, 0])).toBeNull();
  });
});

describe('hidden-hemisphere culling', () => {
  const body = testBody();

  it('the antipode is never visible', () => {
    const cam = cameraAt(20_000, 10, 20);
    const projection = buildProjection(body, cam, view);
    expect(projection.isVisible([-170, -20])).toBe(false);
  });

  it('the sub-camera point is always visible', () => {
    const projection = buildProjection(body, cameraAt(400, 10, 20), view);
    expect(projection.isVisible([10, 20])).toBe(true);
  });

  it('a point just past the horizon is culled, just inside is not', () => {
    const cam = cameraAt(400);
    const projection = buildProjection(body, cam, view);
    const horizonDeg = horizonAngleRad(body, 400) * DEG;

    expect(projection.isVisible([horizonDeg * 0.99, 0])).toBe(true);
    expect(projection.isVisible([horizonDeg * 1.01, 0])).toBe(false);
  });

  it('an elevated target sees past the ground horizon', () => {
    const cam = cameraAt(400);
    const projection = buildProjection(body, cam, view);
    const horizonDeg = horizonAngleRad(body, 400) * DEG;
    const justPast: [number, number] = [horizonDeg * 1.02, 0];

    expect(projection.isVisible(justPast)).toBe(false);
    expect(projection.isVisible(justPast, 11)).toBe(true); // cruising airliner
  });

  it('toCell returns null beyond the clip angle', () => {
    const projection = buildProjection(body, cameraAt(400), view);
    expect(projection.toCell([projection.clipAngleDeg * 1.5, 0])).toBeNull();
  });
});

describe('metersPerCell', () => {
  const body = testBody();

  it('shrinks as the camera descends', () => {
    const high = buildProjection(body, cameraAt(20_000), view).metersPerCell();
    const low = buildProjection(body, cameraAt(400), view).metersPerCell();
    expect(low).toBeLessThan(high);
  });

  // docs/CAMERA.md LOD ladder: L0 (>20 000 km) is ~200 km per cell on a 240x70 grid.
  it('is in the ballpark of the LOD ladder at globe view', () => {
    const perCell = buildProjection(body, cameraAt(20_000), view).metersPerCell();
    expect(perCell / 1000).toBeGreaterThan(100);
    expect(perCell / 1000).toBeLessThan(300);
  });
});
