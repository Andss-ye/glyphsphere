import { LINE_CLASS, SUB_X, type Layer } from '@glyphsphere/core';
import { viewCap } from '../loaders/culling.js';
import { visibleLines, visiblePolygons, type LandTopology } from '../loaders/topojson.js';

/**
 * Land areas and the coastline.
 *
 * This layer is where Fase 2 is won or lost. It declares two different things about the same
 * geometry and lets `reduce` decide how each is drawn:
 *
 * - the **area**, so the shore cell gets a quadrant or a directional edge glyph by coverage;
 * - the **outline** as a COAST line, so wherever the shore is thinner than a cell it comes out
 *   as braille, at 2x4 sub-cell precision.
 *
 * That second declaration is why the coast reads as a continuous stroke instead of a staircase.
 */
export interface LandmaskOptions {
  readonly topology: LandTopology;
  /**
   * Nominal land height, used only when no heightmap is loaded. With `relief` in the stack
   * this must stay undefined: landmask paints after relief, so declaring a height here would
   * overwrite the real elevation field with a single flat value and erase every mountain.
   */
  readonly elevationM?: number;
  /** Coastline thickness, in subcells. */
  readonly coastWidthSubcells?: number;
}

export function landmaskLayer(options: LandmaskOptions): Layer {
  const { topology, elevationM } = options;
  const coastWidth = options.coastWidthSubcells ?? 1;

  return {
    id: 'landmask',
    kind: 'geometry',

    visibleAt: () => true,

    paint(ctx) {
      // Reject by bounding cap before d3 sees a single coordinate, and thin what survives down
      // to the detail the view can actually resolve. At a low altitude this is the difference
      // between streaming 400 000 points and streaming a few thousand; at globe view it rejects
      // nothing and costs one dot product per cap.
      const view = viewCap(ctx.camera.lon, ctx.camera.lat, ctx.projection.visibleGroundRad());

      // One subcell, as an angle on the body: the finest detail this frame can represent.
      const subcellRad =
        ctx.projection.metersPerCell() / SUB_X / (ctx.body.radiusKm * 1000);

      const visibleArea = visiblePolygons(topology.polygons, view, subcellRad);
      const visibleOutline = visibleLines(topology.outlineSegments, view, subcellRad);

      // Coverage and height in one pass: the land polygon is the most expensive geometry in
      // the frame, and streaming it through the projection twice doubles the paint cost.
      ctx.fillArea(visibleArea, elevationM); // height omitted when relief supplies it
      ctx.strokeLine(visibleOutline, LINE_CLASS.COAST, coastWidth);
    },
  };
}
