import type { Body } from './body.js';
import type { CameraState } from './camera/state.js';
import type { Grid } from './grid/grid.js';
import type { LayerStack } from './layers/stack.js';
import { createSampleContext, paintBodySilhouette } from './layers/types.js';
import { buildProjection } from './projection/satellite.js';
import type { ViewMetrics } from './projection/aspect.js';
import { createSampleBuffer, type SampleBuffer } from './raster/sample-buffer.js';
import { BYTES_PER_CELL } from './grid/layout.js';
import { buildChrome, NO_CHROME, type ChromeCommands } from './chrome.js';
import { DEFAULT_RELIEF, reduce, type ReduceOptions, type ReduceResult } from './raster/reduce.js';
import { adaptiveIntervalM, extractContours, meanRisePerSubcellM } from './raster/contour.js';
import { applyCoastalShadow, coastalShadowWidth } from './raster/coastal-shadow.js';

/**
 * What the pipeline renders. N = 1 today (docs/BODIES.md) — the interface exists so that the
 * multi-body scene, when it arrives, does not have to touch every layer.
 */
export interface Scene {
  visibleBodies(camera: CameraState): readonly Body[];
}

/** The only scene there is today: one body, always visible. */
export function singleBodyScene(body: Body): Scene {
  const bodies = [body] as const;
  return {
    visibleBodies: () => bodies,
  };
}

export interface FrameOptions {
  readonly scene: Scene;
  readonly camera: CameraState;
  readonly view: ViewMetrics;
  readonly grid: Grid;
  readonly stack: LayerStack;
  readonly reduce?: Partial<ReduceOptions>;
  /** Relief techniques, each switchable. See docs/RELIEF.md "Configuración". */
  readonly relief?: {
    readonly contours?: boolean;
    readonly contourIntervalM?: number | 'auto';
    readonly coastalShadow?: boolean;
    /**
     * Ground resolution of the elevation source, in metres per sample. Optional; without it
     * contours are drawn at every scale, which is the old behaviour.
     *
     * With it, contours stop once the screen resolves far finer than the data does — see
     * CONTOUR_CELLS_PER_SAMPLE.
     */
    readonly elevationSourceM?: number;
  };
}

export interface Pipeline {
  readonly buffer: SampleBuffer;
  /** Which register produced each cell, from the last frame. */
  readonly registers: Uint8Array;
  /** True when the last frame reused cached geometry instead of repainting. */
  readonly usedCache: boolean;
  /** Vector primitives for the last frame — the limb ring and atmospheric halo. */
  readonly chrome: ChromeCommands;
  render(options: FrameOptions): void;
  /** Forces the next frame to repaint. For a layer whose data arrived asynchronously. */
  invalidate(): void;
}

/**
 * How many cells one elevation sample may span before contours stop being drawn.
 *
 * At 16 cells per sample a contour line has fifteen cells of pure interpolation for every real
 * measurement it touches. Below that ratio the lines still follow measured differences between
 * neighbouring samples; above it they are drawing the interpolator.
 */
const CONTOUR_CELLS_PER_SAMPLE = 16;

/** Everything that changes what the geometry stages produce. */
interface CacheKey {
  bodyId: string;
  lon: number;
  lat: number;
  altitudeKm: number;
  bearingDeg: number;
  stackRevision: number;
}

function sameKey(a: CacheKey | null, b: CacheKey): boolean {
  return (
    a !== null &&
    a.bodyId === b.bodyId &&
    a.lon === b.lon &&
    a.lat === b.lat &&
    a.altitudeKm === b.altitudeKm &&
    a.bearingDeg === b.bearingDeg &&
    a.stackRevision === b.stackRevision
  );
}

/**
 * Builds the per-frame pipeline. Buffers are allocated once here and reused: docs/RENDERING.md
 * is explicit that there must be zero allocation inside the render loop.
 *
 * **Geometry cache** (docs/ARCHITECTURE.md): the glyphs produced by paint + reduce are kept and
 * replayed while the camera is still, so only point and overlay layers redraw. The rule it
 * exists to satisfy: with a still camera and no animated layers, CPU tends to zero — a static
 * globe must not spin up the fan.
 */
export function createPipeline(cols: number, rows: number): Pipeline {
  const buffer = createSampleBuffer(cols, rows);
  const result: ReduceResult = {
    registers: new Uint8Array(cols * rows),
    elevationM: new Float32Array(cols * rows),
  };

  // Glyphs as of the last geometry pass, plus the state that produced them.
  const cachedCells = new Uint8Array(cols * rows * BYTES_PER_CELL);
  let cachedKey: CacheKey | null = null;
  let usedCache = false;
  let chrome: ChromeCommands = NO_CHROME;

  return {
    buffer,
    registers: result.registers,
    get usedCache() {
      return usedCache;
    },
    get chrome() {
      return chrome;
    },

    invalidate(): void {
      cachedKey = null;
    },

    render({ scene, camera, view, grid, stack, reduce: reduceOptions, relief }: FrameOptions): void {
      const key: CacheKey = {
        bodyId: camera.bodyId,
        lon: camera.lon,
        lat: camera.lat,
        altitudeKm: camera.altitudeKm,
        bearingDeg: camera.bearingDeg,
        stackRevision: stack.revision,
      };

      usedCache = sameKey(cachedKey, key) && grid.cells.length === cachedCells.length;

      // The loop over visible bodies runs once today. Writing it now costs a few lines;
      // retrofitting it would mean touching every layer (docs/BODIES.md).
      const bodies = scene.visibleBodies(camera);
      const projections = bodies.map((body) => buildProjection(body, camera, view));

      if (usedCache) {
        grid.cells.set(cachedCells);
      } else {
        grid.cells.fill(0);

        for (let i = 0; i < bodies.length; i++) {
          const body = bodies[i]!;
          const projection = projections[i]!;

          buffer.clear();
          paintBodySilhouette(buffer, projection);

          // 1. Geometry layers declare geometry into the sample buffer. No glyphs chosen here.
          const ctx = createSampleContext(buffer, projection, body, camera);
          for (const layer of stack.active(camera, body, 'geometry')) {
            layer.paint?.(ctx, body);
          }

          // How fast the ground rises per subcell, right now, in this view. Both the contour
          //    interval and the shading strength are derived from it, so one scan serves both
          //    and the two always agree about what counts as steep.
          const riseM = meanRisePerSubcellM(buffer);

          // 2. Contours are found from the elevation field and written as CONTOUR linework,
          //    so they reach the grid through the ordinary braille register. They run before
          //    reduce because reduce is what turns linework into glyphs.
          /**
           * Contours are skipped once the screen resolves far finer than the elevation data.
           *
           * Below that point every line on screen lies *inside* one heightmap sample, so it
           * traces the bilinear interpolation rather than the ground: smooth, plausible, and not
           * a measurement of anything. Over a city it is also actively harmful — those invented
           * curves are braille, they outnumber the street network, and they bury the one thing on
           * screen that is real.
           *
           * ETOPO1 is 9.8 km per sample, so with the threshold below contours fade out at city
           * scale and terrain keeps its bands, its shading and its coastal shadow. The camera
           * reaches further than this dataset does; saying so is better than drawing over it.
           */
          const sourceM = relief?.elevationSourceM;
          const resolvable =
            sourceM === undefined ||
            projection.metersPerCell() * CONTOUR_CELLS_PER_SAMPLE >= sourceM;

          if (relief?.contours !== false && resolvable) {
            const interval =
              relief?.contourIntervalM === undefined || relief.contourIntervalM === 'auto'
                ? adaptiveIntervalM(camera.altitudeKm, riseM)
                : relief.contourIntervalM;
            extractContours(buffer, { intervalM: interval });
          }

          // 3. Reduce the buffer to characters, one register per cell.
          reduce(
            buffer,
            grid,
            body,
            {
              ...reduceOptions,
              relief: { ...DEFAULT_RELIEF, ...reduceOptions?.relief, reliefScaleM: riseM },
            },
            result,
          );

          // 4. Coastal shadow darkens the water beside the shore. It runs on the finished
          //    glyphs because it recolours cells rather than declaring geometry.
          if (relief?.coastalShadow !== false) {
            const width = coastalShadowWidth(camera.altitudeKm);
            const settings = { ...reduceOptions?.relief };
            applyCoastalShadow(
              grid,
              result.registers,
              (x, y) => {
                if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return false;
                const metres = result.elevationM[y * grid.cols + x]!;
                return Number.isFinite(metres) && metres < 0;
              },
              { widthCells: width, sunX: settings.sunX ?? -0.707, sunY: settings.sunY ?? -0.707 },
            );
          }
        }

        // Snapshot here, between geometry and overlays. Overlays are replayed every frame, so
        // caching them would draw them a second time on top of themselves.
        cachedCells.set(grid.cells);
        cachedKey = key;
      }

      // The limb follows the projection, not the layers, so it is rebuilt every frame even
      // when the glyphs come from cache — it costs nothing and it must not lag the camera.
      chrome = bodies.length > 0 ? buildChrome(projections[0]!, bodies[0]!) : NO_CHROME;

      // 3. Point and overlay layers write cells directly — a marker has no coverage. These run
      //    every frame, cache or no cache: a label or a moving marker is not fixed geometry.
      for (let i = 0; i < bodies.length; i++) {
        for (const layer of stack.active(camera, bodies[i]!)) {
          if (layer.kind === 'geometry') continue;
          layer.draw?.(grid, camera, projections[i]!, bodies[i]!);
        }
      }
    },
  };
}
