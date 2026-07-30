/**
 * Cell aspect ratio (width / height). **This lives here and only here** — replicating it is
 * the single most common bug in this project (CLAUDE.md). Without it the planet comes out oval
 * and braille subcells stop being square.
 *
 * With aspect 0.5 a cell is w wide and 2w tall, so a braille subcell is w/2 x 2w/4 = w/2 x w/2:
 * exactly square, which is why a braille diagonal has the same slope on screen as in geographic
 * space (docs/RENDERING.md).
 *
 * 0.5 is the default *until the atlas measures the real font* (docs/AESTHETIC.md) — never assume it.
 */
export const CELL_ASPECT = 0.5;

/**
 * Vertical field of view, in degrees: the full angle the viewport height subtends at the camera.
 *
 * **This is what makes the zoom reach the ground.** The projection is a pinhole camera — the
 * derivation in satellite.ts shows that its radial term `rho(c)` is exactly `tan(alpha)`, the
 * angle off the optical axis. Framing is therefore a choice of lens, and the original code chose
 * "whatever lens makes the horizon touch the viewport edge". That reads fine from orbit and
 * collapses on approach: as altitude falls the horizon closes in at grazing incidence, so the
 * implied lens widens toward 180 degrees and the picture stops zooming. Measured before this
 * existed, the tightest cell the camera could reach was ~1.6 km across — at an altitude of 200 m.
 *
 * A fixed angle instead behaves the way a camera does: ground detail scales with altitude all the
 * way down. 60 degrees is a normal lens, and it puts the crossover — where the body stops
 * overflowing the frame and starts fitting inside it — at `P = 1/sin(fov/2) = 2`, one body radius
 * of altitude.
 */
export const FOV_DEG = 60;

export interface ViewMetrics {
  readonly cols: number;
  readonly rows: number;
  /** Measured from the glyph atlas at runtime. Falls back to CELL_ASPECT. */
  readonly cellAspect: number;
  /** Vertical field of view in degrees. See FOV_DEG. */
  readonly fovDeg: number;
}

export function createViewMetrics(
  cols: number,
  rows: number,
  cellAspect = CELL_ASPECT,
  fovDeg = FOV_DEG,
): ViewMetrics {
  return { cols, rows, cellAspect, fovDeg };
}

/**
 * Half the viewport, in **row units** — the radius the framing maps the field of view onto.
 *
 * Columns are narrower than rows, so they are converted by the aspect before taking the smaller
 * dimension; 0.92 leaves a margin so the limb isn't flush against the viewport edge.
 *
 * This used to be called `discRadiusRows`, because the body's disc was by definition exactly this
 * size. With a field of view that is only true while the body fits inside the frame; closer in,
 * the limb sits outside the viewport and `Projection.radiusRows` reports where.
 */
export function viewportHalfRows(view: ViewMetrics): number {
  return (Math.min(view.cols * view.cellAspect, view.rows) / 2) * 0.92;
}

/**
 * Ground angle subtended between the sub-camera point and a ray `alphaRad` off the optical axis.
 *
 * From the camera-to-surface triangle: the ray leaves the camera at `alpha`, meets the sphere,
 * and the angle at the body centre is `c`. The sine rule over that triangle gives
 * `sin(alpha + c) = P sin(alpha)`, hence `c = asin(P sin alpha) - alpha`.
 *
 * `P sin(alpha) > 1` means the ray misses the body entirely — it passed the horizon, which is why
 * `alpha_horizon = asin(1/P)`. Clamped rather than returned as NaN so callers can ask about the
 * viewport corner without checking first.
 */
export function groundAngleRad(distance: number, alphaRad: number): number {
  const sin = Math.min(1, Math.max(-1, distance * Math.sin(alphaRad)));
  return Math.asin(sin) - alphaRad;
}
