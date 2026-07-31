import type { GeoProjection } from 'd3-geo';
import type { Body } from '../body.js';
import type { CameraState } from '../camera/state.js';
import type { ViewMetrics } from './aspect.js';

/**
 * A d3 projection whose output is already in subcell coordinates, for streaming geometry into
 * the sample buffer. Scaling the projection itself (rather than scaling points afterwards)
 * keeps d3's adaptive resampling tolerance in subcell units, which is what stops long arcs
 * from coming out visibly polygonal.
 */
export interface SubcellProjection {
  readonly projection: GeoProjection;
  /**
   * Horizontal correction applied about the buffer centre, for fonts whose measured aspect
   * isn't exactly SUB_X/SUB_Y. Exactly 1 at the nominal 0.5 aspect.
   */
  readonly correctX: number;
  readonly centreX: number;
}

/**
 * What layers and the pipeline see. Cells, not pixels: `toCell` already applied the aspect
 * correction, so a layer never touches CELL_ASPECT itself.
 */
export interface Projection {
  readonly body: Body;
  readonly camera: CameraState;
  readonly view: ViewMetrics;

  /** Camera distance from the body centre, in body radii. */
  readonly distance: number;
  /** Angular radius of the visible cap, in degrees. */
  readonly clipAngleDeg: number;
  /** Where the limb lands, in row units. Exceeds the viewport once the lens is the narrower. */
  readonly radiusRows: number;

  /**
   * Angular radius of the ground the viewport can actually show, in radians — measured to the
   * corner, so nothing on screen is ever outside it, and capped at the horizon.
   *
   * **This is what layers must cull against**, not the horizon. The two used to be near enough
   * to the same thing that the difference did not matter; with a field of view they diverge by
   * orders of magnitude, and culling to the horizon means streaming a continent's worth of
   * coordinates to draw a neighbourhood.
   */
  visibleGroundRad(): number;

  /** lonLat -> cell coordinates. null when the point is clipped (hidden hemisphere). */
  toCell(lonLat: readonly [number, number]): [number, number] | null;

  /** Cell coordinates -> lonLat. null when the cell is off the body. */
  fromCell(cellXY: readonly [number, number]): [number, number] | null;

  /** Hidden-hemisphere test. `targetAltKm` lets elevated objects see past the ground horizon. */
  isVisible(lonLat: readonly [number, number], targetAltKm?: number): boolean;

  /** Ground distance covered by one cell, for LOD and contour intervals. */
  metersPerCell(): number;

  /** Same projection, retargeted to a subcell-resolution buffer. */
  subcellProjection(subX: number, subY: number): SubcellProjection;
}
