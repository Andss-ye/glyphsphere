import { PAL, solarIncidence, subsolarPoint, type Layer } from '@glyphsphere/core';

/**
 * The day/night line, per docs/AESTHETIC.md.
 *
 * The night side is **not darkened by multiplication**: the glyph is kept and the palette index
 * is swapped. Continents stay legible after dark, in a different key — a planet with half the
 * screen black is half a screen wasted.
 *
 * "A different key" has to mean at least two tones, which is the correction here. Swapping every
 * night cell to a single NIGHT index kept the glyphs and threw away the one thing colour was
 * carrying: at these scales `,` and `·` are both small marks, and land and sea were told apart
 * by hue alone. Flattening them made whole regions read as ocean the moment they turned into
 * the dark — the symptom being "Chile and Central America suddenly look like water". So water
 * goes to NIGHT and everything standing above the sea goes to NIGHTLIT, and the coastline
 * survives sunset.
 *
 * The terminator band itself is about three cells, and the doc calls it the prettiest line in
 * the frame; over water it is NIGHTLIT as documented, and over land it steps up to ALPINE,
 * because NIGHTLIT is now what night land already is and a band the colour of its background is
 * not a band.
 */
export interface TerminatorOptions {
  /** Fixed instant, for tests and snapshots. Defaults to now, so the line actually moves. */
  readonly at?: () => Date;
  /** Half-width of the NIGHTLIT band, as a cosine of incidence. */
  readonly bandWidth?: number;
}

/** Cells between exact inverse projections. See the note in `draw`. */
const SPAN_CELLS = 8;

export function terminatorLayer(options: TerminatorOptions = {}): Layer {
  const at = options.at ?? (() => new Date());
  const bandWidth = options.bandWidth ?? 0.06;

  return {
    id: 'terminator',
    kind: 'overlay',

    // A tidally locked body has a terminator too, but it barely moves; still worth drawing.
    visibleAt: () => true,

    draw(grid, camera, projection, body) {
      const sun = subsolarPoint(at(), body);

      // Which palette indices mean water, asked of the body rather than assumed. A body with no
      // hydrosphere has no such bands and its whole surface takes the land tone.
      const waterIndices = new Set(
        body.bands.filter((band) => band.maxM <= 0).map((band) => band.paletteIndex),
      );

      /** Recolours one cell for a known solar incidence. */
      const shade = (x: number, y: number, incidence: number): void => {
        if (incidence > bandWidth) return; // full daylight, leave it alone

        const cell = grid.get(x, y);
        if (cell.glyph === 0) return;

        // Anything that is not a water band counts as standing above the sea — land, and also
        // borders and graticule, which should dim at night rather than disappear.
        const water = waterIndices.has(cell.fg);

        // Keep the glyph, change only the index: that is what preserves the terrain reading.
        const night =
          incidence > -bandWidth
            ? water
              ? PAL.NIGHTLIT
              : PAL.ALPINE
            : water
              ? PAL.NIGHT
              : PAL.NIGHTLIT;

        grid.set(x, y, cell.glyph, night, cell.bg);
      };

      /** Solar incidence at a cell centre, or null where there is no surface under it. */
      const incidenceAt = (x: number, y: number): number | null => {
        const lonLat = projection.fromCell([x + 0.5, y + 0.5]);
        return lonLat ? solarIncidence(lonLat, sun) : null;
      };

      /**
       * Incidence varies smoothly across the frame, so it is evaluated every `SPAN` cells and
       * interpolated between — the same trade `fillElevationField` makes, and for the same
       * reason: un-projecting is the cost. This ran one inverse projection per cell, 12 726 of
       * them per frame on a 202x63 grid, most of them to conclude "full daylight, leave it".
       *
       * The span is only trusted where its endpoints agree closely; a span whose incidence swings
       * — near the limb, where the inverse is singular, and near the terminator itself, where the
       * answer actually matters — falls back to exact. So the precision is spent on the band and
       * nowhere else.
       */
      const smooth = bandWidth / 4;

      for (let y = 0; y < grid.rows; y++) {
        for (let x0 = 0; x0 < grid.cols; x0 += SPAN_CELLS) {
          const x1 = Math.min(grid.cols - 1, x0 + SPAN_CELLS);
          const a = incidenceAt(x0, y);
          const b = x1 === x0 ? a : incidenceAt(x1, y);

          if (a === null || b === null || Math.abs(a - b) > smooth) {
            for (let x = x0; x <= x1; x++) {
              const exact = incidenceAt(x, y);
              if (exact !== null) shade(x, y, exact);
            }
            continue;
          }

          // Whole span in daylight: nothing to write, and the endpoints already proved it.
          if (a > bandWidth && b > bandWidth) continue;

          const width = x1 - x0;
          for (let x = x0; x <= x1; x++) {
            shade(x, y, width === 0 ? a : a + ((b - a) * (x - x0)) / width);
          }
        }
      }
    },
  };
}
