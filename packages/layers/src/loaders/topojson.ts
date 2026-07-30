import { feature, mesh } from 'topojson-client';
import { geoArea } from 'd3-geo';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { FeatureCollection, MultiLineString, Geometry, Position } from 'geojson';
import {
  boundingCap,
  capIsVisible,
  capRuns,
  resolveLine,
  resolveRing,
  type Cap,
  type RunIndexedRing,
  type ViewCap,
} from './culling.js';

export { boundingCap, capIsVisible, capIsNear, viewCap } from './culling.js';
export type { Cap, ViewCap } from './culling.js';

/** Half the sphere, in steradians. A ring enclosing more than this is inside-out. */
const HEMISPHERE_STERADIANS = 2 * Math.PI;

/**
 * Reorients rings for d3's spherical winding convention.
 *
 * Natural Earth ships shapefile winding (clockwise exterior rings); d3-geo reads a ring's
 * interior as the side to its left, and `topojson.feature()` does not reorient. Left alone,
 * d3 understands each continent as "the whole planet except this shape" — `geoArea` reports
 * 329 % of the globe and every ocean point tests as land. The visible symptom is the view
 * flipping to ocean once the camera descends inside a landmass.
 *
 * The test is the ring's own area: an exterior ring covering more than a hemisphere is
 * inside-out. Interior rings (lakes) are then wound against their exterior.
 */
function rewindPolygon(rings: Position[][]): Position[][] {
  return rings.map((ring, index) => {
    const area = geoArea({ type: 'Polygon', coordinates: [ring] });
    const inverted = index === 0 ? area > HEMISPHERE_STERADIANS : area < HEMISPHERE_STERADIANS;
    return inverted ? [...ring].reverse() : ring;
  });
}

function rewindGeometry(geometry: Geometry): Geometry {
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: rewindPolygon(geometry.coordinates) };
  }
  if (geometry.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(rewindPolygon) };
  }
  return geometry;
}

/**
 * Natural Earth ships as TopoJSON because shared boundaries are stored once, which is ~60 %
 * smaller than the equivalent GeoJSON (docs/DATA.md).
 *
 * Two products come out of one topology, and the distinction matters:
 *
 * - `area` is the **polygon**, used to declare coverage. When it crosses the limb d3 closes it
 *   along the clip circle, which is correct for a fill.
 * - `outline` is the boundary as a **MultiLineString**. Stroking the polygon instead would
 *   paint a phantom coastline along that same clip circle — a bright line across the horizon
 *   wherever a continent runs off the visible hemisphere. Lines get clipped open, not closed,
 *   so the mesh is the right input for linework.
 */

/** A polygon, its overall cap, and a cap per run of each ring. */
export interface CulledPolygon {
  readonly rings: readonly RunIndexedRing[];
  readonly cap: Cap;
}

/** A polyline, its overall cap, and a cap per run. */
export interface CulledLine {
  readonly ring: RunIndexedRing;
  readonly cap: Cap;
}

export interface LandTopology {
  readonly area: FeatureCollection<Geometry>;
  readonly outline: MultiLineString;
  /**
   * The same polygons, run-indexed, for cheap visibility rejection.
   *
   * This is what keeps zoomed-in views affordable. d3 has no spatial index: it streams every
   * coordinate through the projection to discover that it is off-screen, and land-10m holds
   * 400 000 of them — measured at 39 ms per frame against a 10 ms budget for everything.
   */
  readonly polygons: readonly CulledPolygon[];
  /** The outline split into segments, run-indexed. Same reason as `polygons`. */
  readonly outlineSegments: readonly CulledLine[];
}

/**
 * Output rings, reused across frames. docs/RENDERING.md forbids allocation inside the render
 * loop, and the resolve step runs over every visible ring.
 *
 * One pool per call site, not one shared pool: the areas and the outline are both still alive
 * when the layer paints them, so a single pool would hand the second call the arrays the first
 * result is still pointing at.
 */
class RingPool {
  private readonly rings: Position[][] = [];
  private used = 0;

  reset(): void {
    this.used = 0;
  }

  take(): Position[] {
    const ring = this.rings[this.used] ?? [];
    this.rings[this.used] = ring;
    this.used++;
    return ring;
  }
}

const areaPool = new RingPool();
const linePool = new RingPool();

function collectPolygons(collection: FeatureCollection<Geometry>): CulledPolygon[] {
  const out: CulledPolygon[] = [];

  const add = (coordinates: Position[][]) => {
    out.push({ rings: coordinates.map(capRuns), cap: boundingCap(coordinates) });
  };

  for (const item of collection.features) {
    const geometry = item.geometry;
    if (geometry.type === 'Polygon') add(geometry.coordinates);
    else if (geometry.type === 'MultiPolygon') for (const polygon of geometry.coordinates) add(polygon);
  }
  return out;
}

function collectLines(outline: MultiLineString): CulledLine[] {
  return outline.coordinates.map((coordinates) => ({
    ring: capRuns(coordinates),
    cap: boundingCap([coordinates]),
  }));
}

/**
 * The polygons that reach the view, at full detail near the camera and thinned elsewhere.
 *
 * Two levels of rejection, because one is not enough. The per-polygon cap discards an island or
 * a country outright, which is most of the dataset. But a continent's cap covers a third of the
 * planet and always overlaps, so its rings are resolved run by run: the coastline in view keeps
 * every point, the rest of the continent contributes a coarse outline that still encloses the
 * right area. Dropping it entirely is not an option — the polygon would stop containing the
 * camera and the land under it would turn to ocean.
 */
export function visiblePolygons(
  polygons: readonly CulledPolygon[],
  view: ViewCap,
  subcellRad = 0,
): FeatureCollection<Geometry> {
  areaPool.reset();
  const features = [];

  for (const polygon of polygons) {
    if (!capIsVisible(polygon.cap, view)) continue;

    const coordinates: Position[][] = [];
    for (const ring of polygon.rings) {
      const resolved = resolveRing(ring, view, subcellRad, areaPool.take());
      // Fewer than four points cannot close an area; d3 would emit a degenerate path.
      if (resolved.length >= 4) coordinates.push(resolved);
    }
    if (coordinates.length === 0) continue;

    features.push({
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Polygon' as const, coordinates },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * The outline segments that reach the view.
 *
 * A coastline that is off screen contributes nothing to a *stroke* — unlike a fill, a line has no
 * interior to preserve — so `resolveLine` drops the far runs entirely instead of thinning them,
 * splitting the outline into separate polylines where it leaves the view. On land-10m over a
 * dense coast that is the difference between streaming the far side of a continent every frame
 * and streaming none of it.
 */
export function visibleLines(
  lines: readonly CulledLine[],
  view: ViewCap,
  subcellRad = 0,
): MultiLineString {
  linePool.reset();
  const coordinates: Position[][] = [];
  const emit = (segment: Position[]): void => {
    coordinates.push(segment);
  };
  const take = (): Position[] => linePool.take();

  for (const line of lines) {
    if (!capIsVisible(line.cap, view)) continue;
    resolveLine(line.ring, view, subcellRad, take, emit);
  }
  return { type: 'MultiLineString', coordinates };
}

export function parseLandTopology(topology: Topology, objectName = 'land'): LandTopology {
  const object = topology.objects[objectName];
  if (!object) {
    throw new Error(
      `topology has no object "${objectName}" (has: ${Object.keys(topology.objects).join(', ')})`,
    );
  }

  const collection = feature(topology, object as GeometryCollection) as FeatureCollection<Geometry>;

  const area: FeatureCollection<Geometry> = {
    ...collection,
    features: collection.features.map((f) => ({ ...f, geometry: rewindGeometry(f.geometry) })),
  };

  // The mesh is linework, and a line has no interior — winding is irrelevant to it.
  const outline = mesh(topology, object as GeometryCollection);

  return {
    area,
    outline,
    polygons: collectPolygons(area),
    outlineSegments: collectLines(outline),
  };
}
