import { LINE_CLASS, SUB_X, type Layer } from '@glyphsphere/core';
import type { MultiLineString, Position } from 'geojson';
import { boundingCap, capIsVisible, capRuns, resolveRing, viewCap } from '../loaders/culling.js';

/**
 * Country borders. Declared as linework only — a border has no area, it *is* the line — so it
 * comes out in braille through the normal register selection.
 *
 * Drawn from the shared mesh rather than from each country's outline, which is the whole point
 * of keeping the topology: a shared frontier is one line, not two lines drawn on top of each
 * other in slightly different places.
 */
export interface BordersOptions {
  readonly mesh: MultiLineString;
  /** Borders clutter the globe view; they earn their place once countries are legible. */
  readonly maxAltitudeKm?: number;
}

export function bordersLayer(options: BordersOptions): Layer {
  const { mesh } = options;
  const maxAltitudeKm = options.maxAltitudeKm ?? 12_000;

  // Same treatment as the coastline, and for the same reason: without it the whole world's
  // frontiers stream through d3 on every frame, including the ones behind the planet.
  const segments = mesh.coordinates.map((coordinates) => ({
    ring: capRuns(coordinates),
    cap: boundingCap([coordinates]),
    out: [] as Position[],
  }));

  const visible: MultiLineString = { type: 'MultiLineString', coordinates: [] };

  return {
    id: 'borders',
    kind: 'geometry',

    visibleAt: (camera) => camera.altitudeKm <= maxAltitudeKm,

    paint(ctx) {
      const view = viewCap(ctx.camera.lon, ctx.camera.lat, ctx.projection.visibleGroundRad());
      const subcellRad = ctx.projection.metersPerCell() / SUB_X / (ctx.body.radiusKm * 1000);

      visible.coordinates.length = 0;
      for (const segment of segments) {
        if (!capIsVisible(segment.cap, view)) continue;
        const resolved = resolveRing(segment.ring, view, subcellRad, segment.out);
        if (resolved.length >= 2) visible.coordinates.push(resolved);
      }

      ctx.strokeLine(visible, LINE_CLASS.BORDER, 1);
    },
  };
}
