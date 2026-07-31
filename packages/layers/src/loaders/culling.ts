import type { Position } from 'geojson';

/**
 * Spherical-cap culling: the spatial index d3 does not have.
 *
 * d3-geo streams every coordinate of every geometry through the projection in order to discover
 * that it landed off screen. That is fine for a globe view, where nearly everything is on
 * screen, and ruinous close in, where nearly nothing is. Measured on a 240x70 grid at 20 km
 * altitude, before any of this existed: hydro 72 ms and landmask 39 ms, against a 10 ms budget
 * for the entire frame.
 *
 * A cap — a centre and an angular radius — is the cheapest conservative bound on the sphere.
 * Everything here is arithmetic on precomputed unit vectors: `geoDistance` is a haversine, and
 * at one call per run of coordinates the trigonometry alone measured 2.8 ms per frame.
 */

const RAD = Math.PI / 180;

export interface Cap {
  /** Cap centre, [lon, lat]. Kept for tests and debugging; the maths uses the vector. */
  readonly centre: readonly [number, number];
  /** Cap angular radius, radians. */
  readonly radiusRad: number;
  /** Centre as a unit vector, so visibility is a dot product. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cosRadius: number;
  readonly sinRadius: number;
  /** The same, for the radius widened by NEAR_MARGIN. See `capIsNear`. */
  readonly cosNear: number;
  readonly sinNear: number;
}

/** The visible cap: where the camera looks and how far it can see. Built once per frame. */
export interface ViewCap {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cosHorizon: number;
  readonly sinHorizon: number;
}

export function viewCap(lon: number, lat: number, horizonRad: number): ViewCap {
  const phi = lat * RAD;
  const lambda = lon * RAD;
  const cosPhi = Math.cos(phi);
  return {
    x: cosPhi * Math.cos(lambda),
    y: cosPhi * Math.sin(lambda),
    z: Math.sin(phi),
    cosHorizon: Math.cos(horizonRad),
    sinHorizon: Math.sin(horizonRad),
  };
}

/**
 * A run is kept at full detail if it comes within this many of its own radii of the view. The
 * margin is what keeps the bounded error of thinning from ever reaching the screen.
 */
const NEAR_MARGIN = 1;

function makeCap(x: number, y: number, z: number, centre: [number, number], radiusRad: number): Cap {
  const near = Math.min(Math.PI, radiusRad * (1 + NEAR_MARGIN));
  return {
    centre,
    radiusRad,
    x,
    y,
    z,
    cosRadius: Math.cos(radiusRad),
    sinRadius: Math.sin(radiusRad),
    cosNear: Math.cos(near),
    sinNear: Math.sin(near),
  };
}

const WHOLE_SPHERE = makeCap(0, 0, 1, [0, 90], Math.PI);

/** The smallest cap containing every coordinate given, from their Cartesian mean. */
export function boundingCap(rings: readonly (readonly Position[])[]): Cap {
  // Average in Cartesian space: averaging degrees breaks across the antimeridian and at poles.
  let x = 0;
  let y = 0;
  let z = 0;
  let count = 0;

  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      const phi = lat! * RAD;
      const lambda = lon! * RAD;
      const cosPhi = Math.cos(phi);
      x += cosPhi * Math.cos(lambda);
      y += cosPhi * Math.sin(lambda);
      z += Math.sin(phi);
      count++;
    }
  }

  if (count === 0) return WHOLE_SPHERE;

  const length = Math.hypot(x, y, z);
  if (length < 1e-12) return WHOLE_SPHERE;
  x /= length;
  y /= length;
  z /= length;

  // Radius is the angle to the farthest point from that centre.
  let minDot = 1;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      const phi = lat! * RAD;
      const lambda = lon! * RAD;
      const cosPhi = Math.cos(phi);
      const dot = x * cosPhi * Math.cos(lambda) + y * cosPhi * Math.sin(lambda) + z * Math.sin(phi);
      if (dot < minDot) minDot = dot;
    }
  }

  const centre: [number, number] = [
    Math.atan2(y, x) / RAD,
    Math.asin(Math.max(-1, Math.min(1, z))) / RAD,
  ];
  return makeCap(x, y, z, centre, Math.acos(Math.max(-1, Math.min(1, minDot))));
}

/**
 * Does this cap reach the view? Conservative: a cap that merely touches it is kept, and so is
 * the one the camera sits inside.
 *
 * The cap is visible when `distance - radius <= horizon`, which is
 * `cos(distance) >= cos(horizon + radius)`. Expanding the right-hand side by the angle-sum
 * identity leaves only values both the cap and the view already carry, so nothing here is
 * trigonometry — which is the whole point: this runs once per run of 64 coordinates.
 */
export function capIsVisible(cap: Cap, view: ViewCap): boolean {
  const dot = cap.x * view.x + cap.y * view.y + cap.z * view.z;
  return dot >= view.cosHorizon * cap.cosRadius - view.sinHorizon * cap.sinRadius;
}

/** The same test with the cap widened by NEAR_MARGIN, for deciding what keeps full detail. */
export function capIsNear(cap: Cap, view: ViewCap): boolean {
  const dot = cap.x * view.x + cap.y * view.y + cap.z * view.z;
  return dot >= view.cosHorizon * cap.cosNear - view.sinHorizon * cap.sinNear;
}

/** Any GeoJSON-ish thing with a cap precomputed around it. */
export interface Capped<T> {
  readonly cap: Cap;
  readonly value: T;
}

/** Walks a geometry's coordinates, whatever its type, so a cap can be built from any of them. */
function ringsOf(coordinates: unknown, depth: number): Position[][] {
  if (depth <= 1) return [coordinates as Position[]];
  const out: Position[][] = [];
  for (const child of coordinates as unknown[]) out.push(...ringsOf(child, depth - 1));
  return out;
}

/** Nesting depth of each geometry type's `coordinates`, down to a ring of positions. */
const DEPTH: Readonly<Record<string, number>> = {
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
};

/**
 * Precomputes a cap per feature. Whole-feature granularity is right for rivers, lakes and
 * islands, which are small: a cap around one of them is tight. It is *wrong* for a continent,
 * whose cap covers a third of the planet and can never be rejected — that case is what
 * `capRuns` below exists for.
 */
export function capFeatures<T extends { geometry?: { type: string; coordinates?: unknown } | null }>(
  features: readonly T[],
): Capped<T>[] {
  const out: Capped<T>[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || geometry.coordinates === undefined) continue;
    const depth = DEPTH[geometry.type];
    if (depth === undefined) continue;
    out.push({ cap: boundingCap(ringsOf(geometry.coordinates, depth)), value: feature });
  }
  return out;
}

/**
 * Points per cap when a single ring is too big to reject as a whole.
 *
 * A continent's ring is one geometry with one enormous cap, so per-feature culling never drops
 * it and all 400 000 of land-10m's coordinates stream every frame. Splitting the ring into
 * fixed-length runs gives each stretch of coastline its own cap, and the stretches nowhere near
 * the camera can then be thinned.
 */
export const RUN_LENGTH = 64;

/**
 * How much of a far run survives. Far geometry still has to be *there* — dropping it outright
 * would change what the polygon encloses and flip the land under the camera to ocean — but it
 * does not have to be accurate, because it is off screen.
 *
 * Thinning within a run rather than collapsing the run to a chord is deliberate: a chord
 * between two far points can cross the viewport, which would slice a false coastline across the
 * view. Thinning bounds the error by the run's own extent instead.
 */
export const FAR_STRIDE = 24;

export interface RunIndexedRing {
  readonly coordinates: readonly Position[];
  /** One cap per RUN_LENGTH points, in order. */
  readonly caps: readonly Cap[];
  /**
   * Mean angular gap between consecutive points, radians — the detail the data actually holds.
   *
   * Compared against the angular size of a subcell, it says how much of this ring the screen
   * can represent. land-10m resolves about a kilometre; at 400 km altitude a cell covers 36, so
   * thirty-odd points crowd into a space with room for one. Keeping them costs d3 a projection
   * each and changes nothing on screen.
   */
  readonly meanStepRad: number;
}

/** Splits a ring into runs and caps each one. Done at load; never in a frame. */
export function capRuns(coordinates: readonly Position[]): RunIndexedRing {
  const caps: Cap[] = [];
  for (let start = 0; start < coordinates.length; start += RUN_LENGTH) {
    // Overlap by one so a run's cap covers the segment joining it to the next.
    const end = Math.min(coordinates.length, start + RUN_LENGTH + 1);
    caps.push(boundingCap([coordinates.slice(start, end)]));
  }

  // Equirectangular approximation of the gap, which is ample for choosing a stride and avoids
  // a haversine per point across the whole dataset at load.
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1]!;
    const b = coordinates[i]!;
    const dLat = (b[1]! - a[1]!) * RAD;
    const dLon = (b[0]! - a[0]!) * RAD * Math.cos(((a[1]! + b[1]!) / 2) * RAD);
    total += Math.hypot(dLon, dLat);
  }
  const meanStepRad = coordinates.length > 1 ? total / (coordinates.length - 1) : Math.PI;

  return { coordinates, caps, meanStepRad };
}

/** Never thin a ring below this many points, or an island turns into a triangle. */
const MIN_RING_POINTS = 32;

/**
 * Rebuilds a **line** as only the pieces that reach the view, emitting one segment per run of
 * on-screen runs.
 *
 * A line is not a ring: it has no interior, so a stretch that is off screen contributes nothing
 * and can be dropped outright rather than thinned — which `resolveRing` cannot do, because for a
 * *fill* the far geometry still has to enclose the right area.
 *
 * Dropping has to **split**, not join. Silently skipping a middle run would connect the two runs
 * either side of it with a straight chord, and where a coastline leaves the view and comes back
 * that chord is drawn right across the screen. So each contiguous stretch of visible runs becomes
 * its own polyline, and d3 strokes them separately.
 *
 * Runs are kept by `capIsNear` rather than `capIsVisible`, so a run just off screen is still
 * emitted: a stroke has to arrive from beyond the edge, or every coastline would stop short of
 * the viewport border.
 */
export function resolveLine(
  ring: RunIndexedRing,
  view: ViewCap,
  subcellRad: number,
  take: () => Position[],
  emit: (segment: Position[]) => void,
): void {
  const { coordinates, caps, meanStepRad } = ring;
  const last = coordinates.length - 1;
  if (last < 0) return;

  const stride =
    subcellRad > 0 && meanStepRad > 0
      ? Math.max(1, Math.floor(subcellRad / meanStepRad))
      : 1;

  let segment: Position[] | null = null;

  for (let run = 0; run < caps.length; run++) {
    if (!capIsNear(caps[run]!, view)) {
      // The stretch ends here. Anything after it starts a new polyline.
      if (segment !== null && segment.length >= 2) emit(segment);
      segment = null;
      continue;
    }

    if (segment === null) {
      segment = take();
      segment.length = 0;
    }

    const start = run * RUN_LENGTH;
    const end = Math.min(last, start + RUN_LENGTH);
    for (let i = start; i <= end; i += stride) segment.push(coordinates[i]!);
    // The run's final point, so the join to the next run has no gap.
    if (segment[segment.length - 1] !== coordinates[end]) segment.push(coordinates[end]!);
  }

  if (segment !== null && segment.length >= 2) emit(segment);
}

/**
 * Rebuilds a ring at the detail the view can show near the camera, and thinned further
 * everywhere else.
 *
 * Two strides, from two different limits. Near the camera the limit is the **screen**: a
 * subcell is the finest thing the sample buffer can represent, so more than one point per
 * subcell is invisible by construction. Away from it the limit is **relevance**: those points
 * are off screen entirely and only need to keep the ring enclosing the right area. d3's
 * adaptive resampling puts points back along any arc that turns out to need them, so thinning
 * here does not come out polygonal.
 *
 * `subcellRad` is the angular size of one subcell; pass 0 to keep every near point.
 *
 * The last point always survives, so a closed ring stays closed.
 */
export function resolveRing(
  ring: RunIndexedRing,
  view: ViewCap,
  subcellRad: number,
  out: Position[],
): Position[] {
  out.length = 0;
  const { coordinates, caps, meanStepRad } = ring;
  const last = coordinates.length - 1;
  if (last < 0) return out;

  const budget = Math.max(1, Math.floor(coordinates.length / MIN_RING_POINTS));
  const nearStride =
    subcellRad > 0 && meanStepRad > 0
      ? Math.min(budget, Math.max(1, Math.floor(subcellRad / meanStepRad)))
      : 1;
  const farStride = Math.min(Math.max(budget, 1), nearStride * FAR_STRIDE);

  for (let run = 0; run < caps.length; run++) {
    const start = run * RUN_LENGTH;
    const end = Math.min(last, start + RUN_LENGTH - 1);
    const stride = capIsNear(caps[run]!, view) ? nearStride : farStride;

    for (let i = start; i <= end; i += stride) out.push(coordinates[i]!);
  }

  if (out[out.length - 1] !== coordinates[last]) out.push(coordinates[last]!);
  return out;
}
