import {
  BLANK_CODEPOINTS,
  BYTES_PER_CELL,
  CELL_OFFSET,
  buildAtlas,
  Grid,
  NO_CHROME,
  PAL,
  PALETTE,
  paletteColor,
  type ChromeCommands,
  type GlyphAtlas,
} from '@glyphsphere/core';
import { createCanvasGlyphSampler } from './glyph-sampler.js';
import { TintedSheets } from './tinted-sheets.js';

export interface CellMetrics {
  readonly width: number;
  readonly height: number;
}

/** Per docs/AESTHETIC.md: embedded subset first, DejaVu for Linux braille coverage, then any mono. */
const DEFAULT_FONT_STACK = "'Iosevka Web', 'DejaVu Sans Mono', 'Cascadia Mono', monospace";

/** Per docs/AESTHETIC.md: assumed until the atlas measures the font's real aspect. */
const DEFAULT_CELL_ASPECT = 0.5;

export interface CanvasRendererOptions {
  readonly font?: string;
  /** CSS px. Default 14, per docs/API.md GlyphsphereOptions.cellPx. */
  readonly cellHeightPx?: number;
}

/**
 * Canvas2D backend. Draws the grid with a monospace font — no atlas texture yet (that's the
 * tinted-atlas optimization docs/RENDERING.md describes for this backend); `present()` just
 * has to work in phase 0, not hit the WebGL performance budget.
 */
export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly font: string;
  private cellPx: CellMetrics;
  readonly atlas: GlyphAtlas;

  /** La rejilla, conservada entre cuadros. Ver `present`. */
  private readonly gridCanvas: HTMLCanvasElement;
  private gridCtx: CanvasRenderingContext2D;
  private sheets: TintedSheets;
  private previous = new Uint8Array(0);
  private everythingDirty = true;

  constructor(private readonly canvas: HTMLCanvasElement, options: CanvasRendererOptions = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('CanvasRenderer requires a 2D context');
    this.ctx = ctx;
    this.font = options.font ?? DEFAULT_FONT_STACK;

    this.gridCanvas = document.createElement('canvas');
    const gridCtx = this.gridCanvas.getContext('2d');
    if (!gridCtx) throw new Error('CanvasRenderer requires a 2D context');
    this.gridCtx = gridCtx;

    const cellHeightPx = options.cellHeightPx ?? 14;
    this.cellPx = { width: cellHeightPx * DEFAULT_CELL_ASPECT, height: cellHeightPx };
    this.sheets = new TintedSheets(
      this.font,
      this.cellPx.width,
      this.cellPx.height,
      window.devicePixelRatio || 1,
    );

    // One atlas per (charset, font, size, dpr), per docs/RENDERING.md. Built once here; a
    // future LayerStack/resize hook can rebuild it if font or size change.
    const sampler = createCanvasGlyphSampler(
      this.font,
      Math.ceil(this.cellPx.width),
      Math.ceil(this.cellPx.height),
    );
    this.atlas = buildAtlas(sampler, { cellW: this.cellPx.width, cellH: this.cellPx.height });
    warnAboutMissingCoverage(this.atlas);
  }

  /**
   * Cell size in CSS pixels. Anything drawn *over* the grid — a second design layer in real
   * type, a leader line, a selection box — needs this to land on the same lattice the
   * characters do.
   */
  get cellMetrics(): CellMetrics {
    return this.cellPx;
  }

  resize(cols: number, rows: number, cell: CellMetrics = this.cellPx): void {
    const changedCell = cell.width !== this.cellPx.width || cell.height !== this.cellPx.height;
    this.cellPx = cell;

    const dpr = window.devicePixelRatio || 1;
    const widthPx = Math.round(cols * cell.width * dpr);
    const heightPx = Math.round(rows * cell.height * dpr);

    this.canvas.width = widthPx;
    this.canvas.height = heightPx;
    this.canvas.style.width = `${cols * cell.width}px`;
    this.canvas.style.height = `${rows * cell.height}px`;

    // Asignar el tamaño borra el lienzo, así que el próximo cuadro tiene que pintarlo entero.
    this.gridCanvas.width = widthPx;
    this.gridCanvas.height = heightPx;

    for (const context of [this.ctx, this.gridCtx]) {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.font = `${cell.height}px ${this.font}`;
      context.textBaseline = 'top';
    }

    // Las hojas se rasterizan al tamaño de celda: si cambió, las de antes ya no sirven.
    if (changedCell) this.sheets = new TintedSheets(this.font, cell.width, cell.height, dpr);
    this.everythingDirty = true;
  }

  /**
   * Pinta la rejilla.
   *
   * Dos cosas la hacen barata, y las dos hacen falta:
   *
   * - **Los glifos se copian, no se componen.** Cada carácter sale de una hoja ya rasterizada en
   *   su color (`TintedSheets`), así que la celda cuesta un `drawImage` y no un `fillText`.
   * - **Solo se repinta lo que cambió.** La rejilla vive en un lienzo aparte que se conserva
   *   entre cuadros; se compara celda a celda contra el cuadro anterior y se tocan únicamente
   *   las distintas. Al arrastrar cambia casi todo y la ganancia la da el punto anterior; al
   *   quedarse quieto no cambia nada y el cuadro cuesta una copia.
   *
   * El lienzo aparte además es lo que permite lo segundo: el limbo es un trazo vectorial encima,
   * y si se dibujara sobre la propia rejilla habría que borrarlo entero cada cuadro — que es
   * exactamente ensuciar todas las celdas.
   */
  present(grid: Grid, chrome: ChromeCommands = NO_CHROME): void {
    const { cellPx } = this;
    const gridCtx = this.gridCtx;
    const cells = grid.cells;

    // Un cambio de tamaño invalida el lienzo entero: se repinta todo una vez.
    if (this.previous.length !== cells.length) {
      this.previous = new Uint8Array(cells.length);
      this.everythingDirty = true;
    }

    if (this.everythingDirty) {
      gridCtx.fillStyle = paletteColor(PALETTE, PAL.VOID);
      gridCtx.fillRect(0, 0, grid.cols * cellPx.width, grid.rows * cellPx.height);
    }

    const previous = this.previous;
    const all = this.everythingDirty;
    const voidColour = paletteColor(PALETTE, PAL.VOID);

    for (let y = 0, i = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++, i += BYTES_PER_CELL) {
        const lo = cells[i + CELL_OFFSET.GLYPH_LO]!;
        const hi = cells[i + CELL_OFFSET.GLYPH_HI]!;
        const fg = cells[i + CELL_OFFSET.FG]!;
        const bg = cells[i + CELL_OFFSET.BG]!;

        if (
          !all &&
          lo === previous[i]! &&
          hi === previous[i + 1]! &&
          fg === previous[i + 2]! &&
          bg === previous[i + 3]!
        ) {
          continue;
        }

        previous[i] = lo;
        previous[i + 1] = hi;
        previous[i + 2] = fg;
        previous[i + 3] = bg;

        const px = x * cellPx.width;
        const py = y * cellPx.height;

        // Una celda que cambió se repinta desde cero: primero su fondo, porque debajo puede
        // haber quedado el glifo del cuadro anterior.
        gridCtx.fillStyle = bg === PAL.VOID ? voidColour : paletteColor(PALETTE, bg);
        gridCtx.fillRect(px, py, cellPx.width, cellPx.height);

        const glyph = lo | (hi << 8);
        if (glyph === 0 || glyph === 32 || BLANK_CODEPOINTS.has(glyph)) continue;
        this.sheets.draw(gridCtx, glyph, fg, px, py);
      }
    }

    this.everythingDirty = false;

    this.ctx.drawImage(
      this.gridCanvas,
      0,
      0,
      grid.cols * cellPx.width,
      grid.rows * cellPx.height,
    );
    this.drawChrome(chrome);
  }

  /** Fuerza el repintado completo del próximo cuadro. Para un cambio de fuente o de paleta. */
  invalidate(): void {
    this.everythingDirty = true;
  }

  /**
   * The vector pass: the limb ring and the atmospheric halo. Everything else in this project
   * lives in the grid; these two do not, because a character cannot draw a smooth curve
   * (docs/ARCHITECTURE.md).
   */
  private drawChrome(chrome: ChromeCommands): void {
    const { ctx, cellPx } = this;
    if (!chrome.limb && !chrome.halo) return;

    const dpr = window.devicePixelRatio || 1;

    /** Traces the limb as an ellipse, since a cell is taller than it is wide. */
    const traceLimb = (centre: readonly [number, number], radiusRows: number, grow: number) => {
      const cx = centre[0] * cellPx.width;
      const cy = centre[1] * cellPx.height;
      const ry = radiusRows * cellPx.height;
      const rx = ry; // radiusRows is already in row units, which are square on screen
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx + grow, ry + grow, 0, 0, Math.PI * 2);
    };

    // Halo first, so the ring sits on top of it.
    if (chrome.halo) {
      const { centreCell, radiusRows, paletteIndex, widthPx } = chrome.halo;
      // Quadratic falloff, drawn as a few concentric strokes — cheap and indistinguishable
      // from a gradient at these widths.
      const steps = Math.max(2, Math.round(widthPx));
      for (let i = steps; i >= 1; i--) {
        const t = i / steps;
        ctx.globalAlpha = 0.35 * (1 - t) * (1 - t);
        ctx.strokeStyle = paletteColor(PALETTE, paletteIndex);
        ctx.lineWidth = 2;
        traceLimb(centreCell, radiusRows, t * widthPx);
        ctx.stroke();
      }
    }

    if (chrome.limb) {
      const { centreCell, radiusRows, paletteIndex, opacity } = chrome.limb;
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = paletteColor(PALETTE, paletteIndex);
      // One physical pixel, per docs/AESTHETIC.md. No glow, no shadow, no second ring.
      ctx.lineWidth = 1 / dpr;
      traceLimb(centreCell, radiusRows, 0);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  dispose(): void {
    // No listeners or timers registered in this phase — nothing to release yet.
  }
}

function warnAboutMissingCoverage(atlas: GlyphAtlas): void {
  if (atlas.missing.size === 0) return;
  const chars = [...atlas.missing].map((cp) => String.fromCodePoint(cp)).join(' ');
  console.warn(`[glyphsphere] font is missing ${atlas.missing.size} glyph(s): ${chars}`);
}
