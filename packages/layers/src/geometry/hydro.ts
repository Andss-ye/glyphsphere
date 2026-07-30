import { LINE_CLASS, SUB_X, type Layer } from '@glyphsphere/core';
import type { FeatureCollection, Geometry } from 'geojson';
import { viewCap } from '../loaders/culling.js';
import { selectThinned } from './thinned.js';

/**
 * Rivers and lakes.
 *
 * The two are declared differently on purpose, and that difference is the three-register system
 * working as designed:
 *
 * - A **river** is a line. At any planetary zoom it is far thinner than a cell, so it is
 *   declared as RIVER linework and `reduce` renders it in braille at sub-cell precision.
 * - A **lake** is an area. It is declared as coverage *and* as an outline, so its interior
 *   takes the water band while its shore reads as a stroke — the same treatment as a coastline.
 */
export interface HydroOptions {
  readonly rivers?: FeatureCollection<Geometry>;
  readonly lakes?: FeatureCollection<Geometry>;
  /** Rivers only appear once there is room for them. docs/DATA.md puts hydro at L3+. */
  readonly maxAltitudeKm?: number;
  /** Nominal lake surface height; without it a lake would inherit the surrounding terrain. */
  readonly lakeElevationM?: number;
}

/**
 * Natural Earth's `scalerank` is a river hierarchy: 0 is the Amazon, 10 is a minor tributary.
 * Showing every rank at every zoom turns a continent into a hairball, so the threshold opens
 * as the camera descends.
 */
function maxScaleRank(altitudeKm: number): number {
  if (altitudeKm > 4_000) return 2;
  if (altitudeKm > 1_500) return 4;
  if (altitudeKm > 600) return 6;
  if (altitudeKm > 200) return 8;
  return 12;
}

export function hydroLayer(options: HydroOptions): Layer {
  const maxAltitudeKm = options.maxAltitudeKm ?? 6_000;
  const lakeElevationM = options.lakeElevationM ?? 0;

  // Reused every frame. The per-frame `.filter()` this replaces built a fresh FeatureCollection
  // of the whole planet twice a frame.
  const scratch: FeatureCollection<Geometry> = { type: 'FeatureCollection', features: [] };

  return {
    id: 'hydro',
    kind: 'geometry',

    // A river does not exist on a body with no water. The layer says so itself.
    appliesTo: (body) => body.hasHydrosphere,
    visibleAt: (camera) => camera.altitudeKm <= maxAltitudeKm,

    paint(ctx) {
      const rank = maxScaleRank(ctx.camera.altitudeKm);

      // Reject by cap before d3 sees a coordinate. Without this the layer streamed every river
      // on the planet every frame — and because the rank threshold *opens* as the camera
      // descends, it grew more expensive the closer you looked: 72 ms at 20 km altitude.
      const view = viewCap(ctx.camera.lon, ctx.camera.lat, ctx.projection.visibleGroundRad());
      const subcellRad = ctx.projection.metersPerCell() / SUB_X / (ctx.body.radiusKm * 1000);

      if (options.lakes) {
        const lakes = selectThinned(options.lakes, rank, view, subcellRad, scratch);
        // Sea level, so the interior falls in the water bands rather than the land ones.
        ctx.fillArea(lakes, lakeElevationM);
        ctx.strokeLine(lakes, LINE_CLASS.RIVER, 1);
      }

      if (options.rivers) {
        ctx.strokeLine(
          selectThinned(options.rivers, rank, view, subcellRad, scratch),
          LINE_CLASS.RIVER,
          1,
        );
      }
    },
  };
}
