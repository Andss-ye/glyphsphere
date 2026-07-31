import { geoDistance } from 'd3-geo';
import { geoSatellite } from 'd3-geo-projection';
import type { Body } from '../body.js';
import type { CameraState } from '../camera/state.js';
import { groundAngleRad, viewportHalfRows, type ViewMetrics } from './aspect.js';
import type { Projection, SubcellProjection } from './projection.js';
import { cameraDistance, isVisible } from './visibility.js';

const DEG_PER_RAD = 180 / Math.PI;

/**
 * Avoids an exact singularity at the limb, which produces path artifacts in d3.
 * docs/CAMERA.md §2.
 */
const CLIP_EPSILON_DEG = 1e-6;

/**
 * Builds the near-side vertical perspective projection, per docs/CAMERA.md. One projection
 * covers the whole range: as distance grows it converges to orthographic, up close it becomes
 * a surface view. No mode switch, no crossfade.
 *
 * The math here is transcribed from docs/CAMERA.md, which is derived and verified — if a result
 * looks wrong the bug is in how this is called, not in the formulas.
 */
export function buildProjection(body: Body, cam: CameraState, view: ViewMetrics): Projection {
  const P = cameraDistance(body, cam.altitudeKm);
  const clipAngleDeg = Math.acos(1 / P) * DEG_PER_RAD - CLIP_EPSILON_DEG;
  const halfRows = viewportHalfRows(view);

  // rho(c) = sin(c)/(P - cos(c)) is the projection's radial term, and rho(c_horizon) =
  // 1/sqrt(P^2-1). d3's satelliteRaw does not implement raw rho: it returns
  // k = (P-1)/(P - cos(c)), i.e. (P-1) * rho(c). So a scale that puts rho_max at the viewport
  // edge has to divide that normalization back out:
  //
  //   r_edge = scale * (P-1) * rho_max  =!=  halfRows
  //   => scale = halfRows / ((P-1) * rho_max)
  //
  // **What rho_max is, is the framing decision.** rho(c) = tan(alpha), the angle off the optical
  // axis (see groundAngleRad), so choosing rho_max is choosing a lens:
  //
  //   rho_max = rho(c_horizon)  -> the horizon always touches the viewport edge. Correct from
  //             orbit, and the reason zoom used to stall: as altitude falls, c_horizon closes in
  //             at grazing incidence and this implies an ever-wider lens, tending to 180 deg.
  //   rho_max = tan(fov/2)      -> a fixed lens. Ground scale then tracks altitude all the way
  //             down, which is what "zoom continuo hasta nivel de calle" requires.
  //
  // Taking the smaller of the two gives both: the body fits the frame whenever it is small
  // enough to, and the lens takes over once it overflows. min() is continuous, so there is no
  // jump at the crossover (P = 1/sin(fov/2)).
  //
  // Sanity check on the orbital limit: as P -> infinity, rho(c_h) -> 0 so it wins the min, and
  // scale -> halfRows * sqrt((P+1)/(P-1)) -> halfRows while d3's k -> 1. Orthographic of scale
  // halfRows, exactly as before this parameter existed.
  const rhoHorizon = 1 / Math.sqrt(P * P - 1);
  const rhoMax = Math.min(rhoHorizon, Math.tan((view.fovDeg / 2) / DEG_PER_RAD));
  const scale = halfRows / ((P - 1) * rhoMax);

  // Where the limb actually lands, which is no longer the viewport edge: once the lens is
  // narrower than the horizon this exceeds halfRows, i.e. the horizon is off screen. `fromCell`
  // uses it to reject coordinates with no surface under them, and `buildChrome` to decide the
  // limb ring is not worth drawing.
  const radiusRows = halfRows * (rhoHorizon / rhoMax);

  // d3 rotates the world under the camera, not the camera over the world — hence the negated
  // signs. This is the number-one source of confusion with d3-geo.
  const projection = geoSatellite()
    .distance(P)
    .rotate([-cam.lon, -cam.lat, -cam.bearingDeg])
    .clipAngle(clipAngleDeg)
    .scale(scale)
    .translate([view.cols / 2, view.rows / 2]);

  const centreCol = view.cols / 2;
  const centreRow = view.rows / 2;
  const { cellAspect } = view;
  const clipAngleRad = clipAngleDeg / DEG_PER_RAD;

  return {
    body,
    camera: cam,
    view,
    distance: P,
    clipAngleDeg,
    radiusRows,

    toCell(lonLat) {
      // `clipAngle` only clips the *stream*; calling the projection on a bare point ignores it
      // and happily returns coordinates for the far side of the body. So the hidden-hemisphere
      // test has to happen here — it is not optional (CLAUDE.md).
      if (geoDistance([cam.lon, cam.lat], [lonLat[0], lonLat[1]]) >= clipAngleRad) return null;

      const projected = projection([lonLat[0], lonLat[1]]);
      if (!projected) return null;
      // Undo the horizontal squash: the projection works in row units, cells are narrower.
      return [centreCol + (projected[0] - centreCol) / cellAspect, projected[1]];
    },

    fromCell(cellXY) {
      const invert = projection.invert;
      if (!invert) return null;

      // Outside the disc there is no surface point to name. Checked before inverting, because
      // d3's satellite invert returns NaN (or a plausible-looking lie) past the limb.
      const dxRows = (cellXY[0] - centreCol) * cellAspect;
      const dyRows = cellXY[1] - centreRow;
      if (Math.hypot(dxRows, dyRows) > radiusRows) return null;

      const lonLat = invert([centreCol + dxRows, cellXY[1]]);
      if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return null;
      return lonLat;
    },

    isVisible(lonLat, targetAltKm = 0) {
      return isVisible(lonLat, cam, body, targetAltKm);
    },

    visibleGroundRad() {
      // To the viewport corner, so nothing drawn is ever outside the radius. `rho` scales
      // linearly with screen radius, so the corner's rho follows from the edge's by ratio.
      const halfDiagonalRows = Math.hypot((view.cols * cellAspect) / 2, view.rows / 2);
      const rhoCorner = (halfDiagonalRows * rhoMax) / halfRows;
      // atan(rhoHorizon) is the horizon ray, and groundAngleRad saturates there, so the min is
      // what keeps this from claiming ground beyond the limb.
      return groundAngleRad(P, Math.atan(Math.min(rhoCorner, rhoHorizon)));
    },

    metersPerCell() {
      // Ground covered between the view centre and the viewport edge, over the rows it spans.
      // Derived from rho_max rather than from the horizon: with a lens narrower than the horizon
      // those are different numbers, and every caller means "how much ground is one cell" —
      // layers size their thinning by it, so reading the horizon here would leave them thinning
      // for a view hundreds of times wider than the one on screen.
      const arcKm = groundAngleRad(P, Math.atan(rhoMax)) * body.radiusKm;
      return (arcKm * 1000) / halfRows;
    },

    subcellProjection(subX, subY): SubcellProjection {
      // The base projection emits row units. A subcell is 1/subY of a row vertically, so
      // scaling by subY makes the vertical axis exact; the horizontal axis additionally has to
      // pass through the cell aspect, which is what correctX carries.
      //
      // correctX == 1 whenever cellAspect === subX/subY — which at the nominal 0.5 aspect is
      // precisely the statement that braille subcells are square (docs/RENDERING.md).
      const correctX = subX / cellAspect / subY;
      const centreX = (view.cols / 2) * subX;

      const sub = geoSatellite()
        .distance(P)
        .rotate([-cam.lon, -cam.lat, -cam.bearingDeg])
        .clipAngle(clipAngleDeg)
        .scale(scale * subY)
        .translate([centreX, (view.rows / 2) * subY]);

      return { projection: sub, correctX, centreX };
    },
  };
}
