import type { Body } from '../body.js';
import type { Grid } from '../grid/grid.js';
import { PAL } from '../palette/palette.js';
import { BRAILLE_BIT, brailleChar } from './registers/braille.js';
import { quadrantChar } from './registers/quadrant.js';
import { edgeGlyph } from './registers/directional.js';
import { limitBands, selectBand } from './registers/semantic.js';
import { applyShift, embossShift } from './emboss.js';
import { sobelAt } from './sobel.js';
import { LINE_CLASS, type SampleBuffer } from './sample-buffer.js';

/**
 * The heart of the project: given everything declared in one cell, pick the register.
 *
 *   a thin linear feature      -> BRAILLE      (2x4, best geometric precision)
 *   a partially covered area   -> QUADRANT or DIRECTIONAL edge glyph
 *   anything else              -> SEMANTIC     (ASCII whose shape means something)
 *
 * The first condition is what keeps braille from becoming wallpaper. Braille only appears
 * where a feature is genuinely thin at this zoom, so it always reads as "fine detail" and
 * never as background texture (docs/RENDERING.md).
 */

export const REGISTER = {
  NONE: 0,
  BRAILLE: 1,
  QUADRANT: 2,
  DIRECTIONAL: 3,
  SEMANTIC: 4,
} as const;

export type Register = (typeof REGISTER)[keyof typeof REGISTER];

/** The four relief techniques, individually switchable. docs/RELIEF.md "Configuración". */
export interface ReliefSettings {
  /** How many hypsometric bands to show. The LOD ladder narrows this when zoomed out. */
  readonly bands: number | 'auto';
  /** Gradient shading against the sun. */
  readonly emboss: boolean;
  /** Light direction in screen space, from `solarScreenDirection`. */
  readonly sunX: number;
  readonly sunY: number;
  /**
   * Terrain rise per subcell that counts as a full-strength slope, in metres. Feed it
   * `meanRisePerSubcellM` and shading calibrates itself to the terrain actually in view, so a
   * fjord at 700 km and the Himalaya at 2000 km both read as relief instead of one being flat
   * and the other solid black.
   *
   * Optional because the pipeline measures it from the frame; a caller has no better number.
   */
  readonly reliefScaleM?: number;
}

/**
 * A Sobel over a uniform slope of `r` metres per subcell gives magnitude `2r / fullScale`, so
 * `fullScale = 8 x meanRise` puts average terrain at 0.25 — well clear of EMBOSS_MIN (0.08),
 * with ground three times gentler than average left unshaded.
 */
export const EMBOSS_SCALE_FACTOR = 8;

export const DEFAULT_RELIEF: ReliefSettings = {
  bands: 'auto',
  emboss: true,
  sunX: -0.707,
  sunY: -0.707,
  reliefScaleM: 100,
};

export interface ReduceOptions {
  /** Below this the cell counts as uncovered, above it as fully covered. */
  readonly coverageLow: number;
  readonly coverageHigh: number;
  readonly relief: ReliefSettings;
  /**
   * How clean the Sobel gradient has to be before an edge is traced with a directional glyph
   * instead of stepped with a quadrant. Calibrated by eye; the playground `registers` panel
   * is the tool for re-tuning it.
   */
  readonly edgeThreshold: number;
  /** Palette index per line class. */
  readonly lineColors: Readonly<Record<number, number>>;
}

export const DEFAULT_REDUCE_OPTIONS: ReduceOptions = {
  coverageLow: 0.05,
  coverageHigh: 0.95,
  edgeThreshold: 0.35,
  relief: DEFAULT_RELIEF,
  lineColors: {
    [LINE_CLASS.COAST]: PAL.LITTORAL,
    [LINE_CLASS.RIVER]: PAL.SHELF,
    [LINE_CLASS.CONTOUR]: PAL.STEPPE,
    // A master contour is a step brighter, so contour density reads instead of saturating.
    [LINE_CLASS.CONTOUR_MASTER]: PAL.ALPINE,
    [LINE_CLASS.BORDER]: PAL.CHROME,
    [LINE_CLASS.ROAD]: PAL.CHROME,
    [LINE_CLASS.GRATICULE]: PAL.CHROME,
    // NIGHTLIT is literally "built-up, lit after dark" — and dim enough that the road network
    // stays the figure and the city footprint stays the ground.
    [LINE_CLASS.URBAN]: PAL.NIGHTLIT,
  },
};

export interface ReduceResult {
  /** Which register produced each cell. Feeds the playground `registers` panel. */
  readonly registers: Uint8Array;
  /** Mean elevation per cell, in metres. Lets later stages find the water without re-reading. */
  readonly elevationM: Float32Array;
}

/**
 * Quadrant coverage. A quadrant is half a cell wide and half a cell tall, so with a 2x4
 * subcell grid each one spans 1 column x 2 rows of subcells.
 */
const QUADRANT_BITS = [
  { bit: 0x1, sx: 0, sy: 0 }, // TL
  { bit: 0x2, sx: 1, sy: 0 }, // TR
  { bit: 0x4, sx: 0, sy: 2 }, // BL
  { bit: 0x8, sx: 1, sy: 2 }, // BR
] as const;

export function reduce(
  buffer: SampleBuffer,
  grid: Grid,
  body: Body,
  options: Partial<ReduceOptions> = {},
  out?: ReduceResult,
): ReduceResult {
  const opts = { ...DEFAULT_REDUCE_OPTIONS, ...options };
  const relief = { ...DEFAULT_RELIEF, ...options.relief };
  const { subX, subY, width, coverage, elevation, lineMask, lineClass, bodyMask } = buffer;
  const subPerCell = subX * subY;

  const registers = out?.registers ?? new Uint8Array(grid.cols * grid.rows);
  const elevationOut = out?.elevationM ?? new Float32Array(grid.cols * grid.rows);
  registers.fill(REGISTER.NONE);

  // Thinned once per frame, not per cell.
  const bands =
    relief.bands === 'auto' ? body.bands : limitBands(body.bands, relief.bands);

  /**
   * Shading may only move within the **land** ramp, never into water or instrument colours.
   *
   * Taking the floor from every band, bathymetry included, is what let a shaded plain land on
   * SHELF and a mountainside on PELAGIC: the glyph still read as land while the colour read as
   * ocean. It appeared as blue strips down the Pacific side of the Andes, it moved whenever the
   * globe turned — the light direction is in screen space — and it got worse zoomed out, where
   * more terrain per subcell means a steeper measured gradient.
   *
   * Only land is shaded (`shadeFor` returns early below sea level), so the land bands are the
   * only ones the clamp has to admit.
   */
  const landBands = bands.filter((band) => band.maxM > 0);
  const terrainMin = landBands.length > 0 ? Math.min(...landBands.map((b) => b.paletteIndex)) : 0;
  const terrainMax = landBands.length > 0 ? Math.max(...landBands.map((b) => b.paletteIndex)) : 15;

  // Floored so a dead-flat view (an ocean, or a body with no heightmap yet) cannot divide the
  // gradient by nothing and report every subcell as a cliff.
  const embossScaleM = Math.max(1, (relief.reliefScaleM ?? 100) * EMBOSS_SCALE_FACTOR);

  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const baseSubX = cx * subX;
      const baseSubY = cy * subY;

      // --- Read the cell's subcells once ---------------------------------------------
      let braille = 0;
      let dominantClass = LINE_CLASS.NONE as number;
      let covered = 0;
      let onBody = 0;
      let elevationSum = 0;

      for (let row = 0; row < subY; row++) {
        const rowStart = (baseSubY + row) * width + baseSubX;
        for (let col = 0; col < subX; col++) {
          const i = rowStart + col;

          if (lineMask[i] !== 0) {
            braille |= BRAILLE_BIT[col as 0 | 1]![row as 0 | 1 | 2 | 3]!;
            dominantClass = lineClass[i]!;
          }
          if (coverage[i] !== 0) covered++;
          if (bodyMask[i] !== 0) onBody++;
          elevationSum += elevation[i]!;
        }
      }

      const cellIndex = cy * grid.cols + cx;

      // Off the body entirely: space. Leaving the cell empty is deliberate — the star field
      // and the limb ring are drawn later, by other stages.
      if (onBody === 0) {
        elevationOut[cellIndex] = Number.NaN;
        continue;
      }

      // --- Register 1: linework -------------------------------------------------------
      if (braille !== 0) {
        const colour = opts.lineColors[dominantClass] ?? PAL.CHROME;
        grid.set(cx, cy, brailleChar(braille), colour);
        registers[cellIndex] = REGISTER.BRAILLE;
        continue;
      }

      const coverageFraction = covered / subPerCell;
      const elevationM = elevationSum / subPerCell;
      elevationOut[cellIndex] = elevationM;

      /**
       * Gradient shading, per docs/RELIEF.md §3. Applied only to land: the ocean has no relief
       * worth reading at these scales and shading it just makes it noisy.
       */
      const shadeFor = (paletteIndex: number): number => {
        if (!relief.emboss || elevationM < 0) return paletteIndex;
        const slope = sobelAt(
          elevation,
          width,
          buffer.height,
          baseSubX + (subX >> 1),
          baseSubY + (subY >> 1),
          embossScaleM,
        );
        const shift = embossShift(
          Math.cos(slope.angleRad),
          Math.sin(slope.angleRad),
          relief.sunX,
          relief.sunY,
          slope.magnitude,
        );
        return applyShift(paletteIndex, shift, terrainMin, terrainMax);
      };

      // --- Register 2: area border ----------------------------------------------------
      // Only where the whole cell is on the body. A cell straddling the limb always shows a
      // coverage step, because d3 closes clipped polygons along the clip circle — reading that
      // as a coastline paints a ring of spurious quadrants around the disc. The silhouette
      // edge is the limb's job (a vector ring), not the area register's.
      const fullyOnBody = onBody === subPerCell;

      if (
        fullyOnBody &&
        coverageFraction > opts.coverageLow &&
        coverageFraction < opts.coverageHigh
      ) {
        const gradient = sobelAt(
          coverage,
          width,
          buffer.height,
          baseSubX + (subX >> 1),
          baseSubY + (subY >> 1),
        );

        let glyph: number;
        if (gradient.magnitude > opts.edgeThreshold) {
          // Clean edge: trace it, don't step it.
          glyph = edgeGlyph(gradient.angleRad);
          registers[cellIndex] = REGISTER.DIRECTIONAL;
        } else {
          let quadMask = 0;
          for (const { bit, sx, sy } of QUADRANT_BITS) {
            const a = coverage[(baseSubY + sy) * width + baseSubX + sx]!;
            const b = coverage[(baseSubY + sy + 1) * width + baseSubX + sx]!;
            // Both subcells, not either: a quadrant reports *mass*. Setting it on a single
            // sample turns a half-covered cell into a full block, which reads as solid land
            // where there is a shoreline.
            if (a !== 0 && b !== 0) quadMask |= bit;
          }
          glyph = quadrantChar(quadMask);
          registers[cellIndex] = REGISTER.QUADRANT;
        }

        grid.set(cx, cy, glyph, shadeFor(selectBand(bands, elevationM).paletteIndex));
        continue;
      }

      // --- Register 3: semantic fill --------------------------------------------------
      const band = selectBand(bands, elevationM);
      grid.set(cx, cy, band.glyph.codePointAt(0) ?? 0x20, shadeFor(band.paletteIndex));
      registers[cellIndex] = REGISTER.SEMANTIC;
    }
  }

  return { registers, elevationM: elevationOut };
}
