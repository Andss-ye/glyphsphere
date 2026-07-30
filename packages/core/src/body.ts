import type { Palette } from './palette/palette.js';
import type { LodLevel } from './lod/ladder.js';

/**
 * A celestial body, per docs/BODIES.md. This is the *type* only — it holds no values, so it
 * doesn't violate "nada de constantes de la Tierra en core". Concrete profiles (earth today,
 * moon later) live in @glyphsphere/bodies, which depends on core, never the other way round.
 *
 * The type lives here because core's own API surface needs it: Projection is built from
 * (CameraState, Body), and Layer.paint/draw receive it.
 */
export interface Body {
  readonly id: string;
  readonly name: string;
  readonly radiusKm: number;
  /** 1/298.257 for Earth, 0 for a perfect sphere. */
  readonly flattening: number;

  /** Range used to normalize the heightmap. */
  readonly elevationRangeM: readonly [min: number, max: number];

  /** Hypsometric bands. See docs/RELIEF.md. */
  readonly bands: readonly ElevationBand[];

  /** Default palette. A body with no atmosphere or water needs a different one. */
  readonly palette: Palette;

  /** Decides whether water layers and the coastal shadow exist at all. */
  readonly hasHydrosphere: boolean;

  /** Atmospheric halo at the limb. null means a hard limb. */
  readonly atmosphere: AtmosphereSpec | null;

  /** Drives solar position and the terminator. */
  readonly rotation: RotationSpec;

  readonly datasets: DatasetManifest;
}

/** One quantized elevation band: everything up to `maxM` draws as `glyph` in `paletteIndex`. */
export interface ElevationBand {
  readonly maxM: number;
  readonly glyph: string;
  readonly paletteIndex: number;
  /**
   * What this band *is*, in words — "continental shelf", "high mountains". Optional and unused
   * by the render path: a glyph and a colour are all a character needs.
   *
   * It exists for `@glyphsphere/agent`, which answers questions about a place in text rather
   * than in glyphs. The name belongs to the body, not to core: "abyssal plain" is a fact about
   * Earth's hydrosphere and would be nonsense on the Moon.
   */
  readonly name?: string;
}

export interface AtmosphereSpec {
  /** Palette index of the halo colour. */
  readonly paletteIndex: number;
  /** Halo width outward from the limb, in CSS px. 2-4 per docs/AESTHETIC.md. */
  readonly haloPx: number;
}

export interface RotationSpec {
  /** Sidereal rotation period. Earth is 23h56m, not 24h. */
  readonly siderealPeriodHours: number;
  /** Axial tilt; drives the seasonal swing of the terminator. */
  readonly axialTiltDeg: number;
  /** Tidally locked to its primary (the Moon is; Earth isn't). */
  readonly tidallyLocked: boolean;
}

/**
 * Which dataset backs which LOD. Consumed by @glyphsphere/layers when it loads geometry;
 * core only carries the type. Entries are asset ids resolved by @glyphsphere/data.
 */
export interface DatasetManifest {
  /** Coastline/landmask topology per LOD. */
  readonly land: Partial<Record<LodLevel, string>>;
  /** 16-bit heightmap, if the body has elevation data. */
  readonly heightmap?: string;
  /** Populated places / named surface features. */
  readonly places?: string;
  /** Rivers and lakes. Absent on a body with no hydrosphere. */
  readonly hydro?: Partial<Record<LodLevel, string>>;
  readonly borders?: Partial<Record<LodLevel, string>>;
  /** Road network and built-up footprint, for the levels close enough to show them. */
  readonly urban?: Partial<Record<LodLevel, string>>;
}
