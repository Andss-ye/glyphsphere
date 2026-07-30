import { geoPath, type GeoPermissibleObjects } from 'd3-geo';
import type { Body } from '../body.js';
import type { CameraState } from '../camera/state.js';
import type { Grid } from '../grid/grid.js';
import type { Projection } from '../projection/projection.js';
import {
  PathSink,
  fillRings,
  strokeRings,
  type LineClass,
  type SampleBuffer,
} from '../raster/sample-buffer.js';

/**
 * What a geometry layer draws with. Deliberately narrow: a layer declares **geometry and
 * class**, never colour and never a glyph (docs/API.md). Which character represents a coastline
 * is `reduce`'s decision, made with the whole cell in view — that is the difference between
 * this project and an image-to-ASCII converter.
 */
export interface SampleContext {
  readonly buffer: SampleBuffer;
  readonly projection: Projection;
  readonly body: Body;
  readonly camera: CameraState;

  /**
   * Declares an area: this is land, this is a lake, this is a city block. Pass `elevationM` to
   * declare its height in the same call — projecting the same geometry twice is the single
   * most expensive mistake a layer can make (it measured 11 ms per extra pass on land-50m).
   */
  fillArea(geometry: GeoPermissibleObjects, elevationM?: number): void;

  /** Declares ground height over an area without touching coverage. For the water surface. */
  fillElevation(geometry: GeoPermissibleObjects, elevationM: number): void;

  /**
   * Declares ground height as a **field** rather than a shape: called once per subcell on the
   * body with that subcell's lon/lat. This is how a heightmap gets in — it has no geometry to
   * fill, it has a value everywhere.
   */
  fillElevationField(sampleAt: (lon: number, lat: number) => number): void;

  /**
   * Declares a linear feature. Width is in subcells, not pixels.
   *
   * `dense` is an assertion about the *geometry*, not a quality setting: it says this geometry
   * spans a patch small enough that the projection over it is affine to within d3's own
   * resampling precision, so resampling cannot move anything into a different subcell. Skipping
   * it measured 30 % off the street layer's cost (5.8 ms -> 4.0 ms over Bogotá).
   *
   * It is emphatically **not** "the vertices are closer than a subcell" — street data simplified
   * at bake time emits chords up to 6.5 km long down a straight avenue, and it is still exact.
   * What makes it exact is the extent of the whole patch, not the spacing within it. Asserting it
   * for geometry that crosses the globe draws arcs as chords, so it is wrong for a coastline, a
   * border or a graticule, and `streets.test.ts` pins the one caller that does claim it by
   * comparing every subcell against the resampled frame.
   */
  strokeLine(
    geometry: GeoPermissibleObjects,
    lineClass: LineClass | number,
    widthSubcells?: number,
    dense?: boolean,
  ): void;
}

/**
 * Subcells between exact inverse projections in `fillElevationField`, in the two regimes the
 * projection actually has. See the table at the point of use for the measurements behind them.
 *
 * Un-projecting every subcell is what the field costs: measured on a 202x63 grid, the inverse
 * projection is 4.9 ms of the layer's 5.4 ms while the bilinear heightmap read is only 0.4 ms.
 * The inverse is smooth away from the limb, so it is evaluated at span endpoints and interpolated
 * between.
 */
const SPAN_WITH_LIMB = 8;
const SPAN_NO_LIMB = 64;


export type LayerKind = 'geometry' | 'point' | 'overlay';

export interface Layer {
  readonly id: string;
  readonly kind: LayerKind;

  /** Does this make sense on this body? A river does not exist on the Moon. */
  appliesTo?(body: Body): boolean;

  /** Should it draw at this altitude? Cuts the whole layer before it iterates anything. */
  visibleAt(camera: CameraState, body: Body): boolean;

  /** Called when the detail level changes. Data loading goes here. */
  onLodChange?(lod: string, body: Body): void | Promise<void>;

  /** geometry -> declare geometry into the sample buffer. */
  paint?(ctx: SampleContext, body: Body): void;

  /** point | overlay -> write cells directly. */
  draw?(grid: Grid, camera: CameraState, projection: Projection, body: Body): void;
}

/**
 * Builds the drawing context for one body, one frame. The d3 path streams geometry through the
 * subcell-space projection, so clipping to the visible hemisphere and antimeridian handling
 * come for free and identically for every layer.
 *
 * ponytail: a moving camera re-streams every layer's geometry each frame, and d3 has no spatial
 * index — it projects every coordinate to discover it is off screen. The geometry cache already
 * makes a still camera free, so this is only paid while actively dragging.
 *
 * Two fixes have been measured on a 240x70 grid at L4 with land-10m:
 *   - Spherical-cap culling per polygon and per outline segment: 87 ms -> 39 ms, applied.
 *   - Visvalingam simplification per LOD, which docs/DATA.md step 3 calls for: rejected. At a
 *     half-cell tolerance it removed only 20-36 % of points while tripling the files, because
 *     simplification discards the topology's integer quantization.
 *
 * The 39 ms that remain are one continent's worth of coordinates: a bounding cap around South
 * America overlaps any nearby view, so culling cannot reject it, and subdividing it further is
 * precisely what tiling means. That is Fase 6 (docs/DATA.md, nivel urbano), not a threshold to
 * tune here. L0-L3 are inside budget; L4 is playable but not.
 */
export function createSampleContext(
  buffer: SampleBuffer,
  projection: Projection,
  body: Body,
  camera: CameraState,
): SampleContext {
  const { projection: subProjection, correctX, centreX } = projection.subcellProjection(
    buffer.subX,
    buffer.subY,
  );
  const sink = new PathSink(correctX, centreX);
  const path = geoPath(subProjection, sink);

  /**
   * The same path with resampling off, for geometry that is already finer than a subcell.
   *
   * Built on demand and thrown away with the context: most frames never draw dense geometry, and
   * the layers that do are the ones under the frame-budget pressure that motivated this.
   */
  let densePath: typeof path | null = null;
  const denseFor = (): typeof path => {
    if (densePath === null) {
      // A second instance, because precision is per-projection: the coastline in the same frame
      // still needs resampling, and turning it off for everyone draws continents as polygons.
      densePath = geoPath(projection.subcellProjection(buffer.subX, buffer.subY).projection.precision(0), sink);
    }
    return densePath;
  };

  return {
    buffer,
    projection,
    body,
    camera,

    fillArea(geometry, elevationM) {
      sink.beginPath();
      path(geometry);
      // One projection, two channels. The rings are already in hand; filling a second buffer
      // from them is cheap, re-streaming the geometry through d3 is not.
      fillRings(sink.result, buffer.coverage, buffer.width, buffer.height);
      if (elevationM !== undefined) {
        fillRings(sink.result, buffer.elevation, buffer.width, buffer.height, elevationM);
      }
    },

    fillElevation(geometry, elevationM) {
      sink.beginPath();
      path(geometry);
      fillRings(sink.result, buffer.elevation, buffer.width, buffer.height, elevationM);
    },

    fillElevationField(sampleAt) {
      const { subX, subY, width, height, bodyMask, elevation } = buffer;

      const exactAt = (sx: number, cellY: number): [number, number] | null =>
        projection.fromCell([(sx + 0.5) / subX, cellY]) as [number, number] | null;

      /**
       * How many subcells one interpolated span covers.
       *
       * A span that fails the linearity check below falls back to un-projecting every subcell in
       * it, so the width is a two-sided bet: too narrow wastes probes where the inverse is
       * smooth, too wide pays the fallback over a long run where it is not. There is exactly one
       * place the inverse is not smooth — the limb, where it is singular — so the width follows
       * whether the limb is on screen at all.
       *
       * With a lens narrower than the horizon the limb is outside the viewport entirely and the
       * inverse is smooth across the whole frame, which is what wide spans are for. Measured over
       * Bogota, per call, on a 202x63 grid:
       *
       *            20 000 km   2 000 km    150 km      1 km      (limb: in frame | off screen)
       *   span  8     2.8 ms     5.4 ms    5.1 ms    5.3 ms
       *   span 64     7.9 ms    16.0 ms    2.5 ms    2.5 ms
       *
       * Switching on the limb takes the better column in every case.
       */
      const halfDiagonalRows = Math.hypot(
        (projection.view.cols * projection.view.cellAspect) / 2,
        projection.view.rows / 2,
      );
      const span =
        projection.radiusRows > halfDiagonalRows ? SPAN_NO_LIMB : SPAN_WITH_LIMB;

      for (let sy = 0; sy < height; sy++) {
        const cellY = (sy + 0.5) / subY;
        const rowStart = sy * width;

        // Carried across spans: each span's right endpoint is the next one's left.
        let left: [number, number] | null = null;
        let leftX = -1;

        for (let x0 = 0; x0 < width; x0 += span) {
          const x1 = Math.min(width - 1, x0 + span);

          // Only where the body is: inverting off-disc coordinates is wasted work, and there
          // is no ground there to have a height.
          let onBody = false;
          for (let sx = x0; sx <= x1; sx++) {
            if (bodyMask[rowStart + sx] !== 0) {
              onBody = true;
              break;
            }
          }
          if (!onBody) {
            left = null;
            continue;
          }

          const a = leftX === x0 ? left : exactAt(x0, cellY);
          const b = exactAt(x1, cellY);
          left = b;
          leftX = x1;

          /**
           * Interpolate only where the inverse projection is near enough to linear to be
           * indistinguishable from it — checked, not assumed, by un-projecting the midpoint and
           * comparing it against what the lerp predicts.
           *
           * The tolerance is derived from the span itself: a deviation smaller than half a
           * subcell cannot change which subcell a sample belongs to, so it cannot change the
           * picture. This also handles the two cases a fixed threshold was there to catch —
           * near the limb the inverse is singular and the midpoint diverges sharply, and across
           * the antimeridian lerping degrees runs the long way round the planet, which the
           * midpoint reports as being half a world out.
           */
          let linear = false;
          if (a !== null && b !== null) {
            const mid = exactAt((x0 + x1) >> 1, cellY);
            if (mid !== null) {
              const toleranceDeg =
                Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) / (2 * span);
              linear =
                Math.abs(mid[0] - (a[0] + b[0]) / 2) <= toleranceDeg &&
                Math.abs(mid[1] - (a[1] + b[1]) / 2) <= toleranceDeg;
            }
          }

          /**
           * Spans share their endpoint — `x1` of one is `x0` of the next — because the inverse
           * is carried across to save a projection. Only the *interpolation* wants that overlap;
           * writing it too made every span boundary get sampled twice, which measured 114 408
           * heightmap samples for 101 808 subcells. So each span writes half-open, and only the
           * final one, which has nothing after it, closes on its right endpoint.
           */
          const width0 = x1 - x0;
          const lastSubcell = x1 === width - 1 ? x1 : x1 - 1;
          for (let sx = x0; sx <= lastSubcell; sx++) {
            const index = rowStart + sx;
            if (bodyMask[index] === 0) continue;

            let lon: number;
            let lat: number;
            if (linear) {
              const t = width0 === 0 ? 0 : (sx - x0) / width0;
              lon = a![0] + (b![0] - a![0]) * t;
              lat = a![1] + (b![1] - a![1]) * t;
            } else {
              const exact = exactAt(sx, cellY);
              if (!exact) continue;
              lon = exact[0];
              lat = exact[1];
            }

            // Metres straight in. Int16 covers every rocky body's range with a metre to spare.
            elevation[index] = sampleAt(lon, lat);
          }
        }
      }
    },

    strokeLine(geometry, lineClass, widthSubcells = 1, dense = false) {
      sink.beginPath();
      (dense ? denseFor() : path)(geometry);
      strokeRings(
        sink.result,
        buffer.lineMask,
        buffer.lineClass,
        buffer.width,
        buffer.height,
        lineClass,
        widthSubcells,
        sink.closed,
      );
    },
  };
}

/** Rasterizes the body silhouette. Not a layer's job: it follows from the projection. */
export function paintBodySilhouette(buffer: SampleBuffer, projection: Projection): void {
  const { projection: subProjection, correctX, centreX } = projection.subcellProjection(
    buffer.subX,
    buffer.subY,
  );
  const sink = new PathSink(correctX, centreX);
  const path = geoPath(subProjection, sink);

  sink.beginPath();
  path({ type: 'Sphere' });
  fillRings(sink.result, buffer.bodyMask, buffer.width, buffer.height);
}
