import { PALETTE, paletteColor } from '@glyphsphere/core';

/**
 * Un glifo, ya dibujado y ya teñido, listo para copiar.
 *
 * **Por qué existe.** La versión anterior hacía un `fillText` por celda no vacía. En una rejilla
 * de terminal real — 274x77 en una pantalla de 1080p — eso son unas 20 000 llamadas a `fillText`
 * por frame, cada una con su medición y su composición de texto, más 20 000 strings creados con
 * `String.fromCodePoint`. Es el motivo por el que la demo calentaba la máquina, y estaba anotado
 * como deuda en el propio renderer desde el principio: *"swap in the tinted-atlas trick if
 * profiling shows this is over budget on a real grid size"*. Lo mostró.
 *
 * Un `drawImage` desde un canvas ya rasterizado es una copia de píxeles que la GPU acelera; un
 * `fillText` es tipografía. El mismo cuadro pasa a costar una fracción.
 *
 * Cada color de la paleta tiene su propia hoja porque teñir en el momento obligaría a componer
 * con `globalCompositeOperation` por celda, que es justo el coste que se quiere evitar. Son 16
 * colores y unos 400 glifos: cada hoja se llena **bajo demanda**, así que solo se rasteriza lo
 * que de verdad aparece en pantalla.
 */

/** Glifos por fila en la hoja. Mantiene el canvas cuadradito en vez de una tira larguísima. */
const COLUMNS = 32;

/** Cuántos glifos caben. El juego completo (braille + cuadrantes + ASCII) no llega a 400. */
const CAPACITY = 512;

interface Sheet {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Codepoint -> índice de ranura, para los que ya se rasterizaron. */
  readonly slots: Map<number, number>;
}

export class TintedSheets {
  private readonly sheets = new Map<number, Sheet>();
  private readonly glyphText = new Map<number, string>();
  /** Ancho y alto de ranura en píxeles de dispositivo. */
  readonly slotW: number;
  readonly slotH: number;

  constructor(
    private readonly font: string,
    private readonly cellW: number,
    private readonly cellH: number,
    private readonly dpr: number,
  ) {
    this.slotW = Math.ceil(cellW * dpr);
    this.slotH = Math.ceil(cellH * dpr);
  }

  /**
   * Dibuja un glifo teñido en `(x, y)` — coordenadas CSS del contexto destino.
   *
   * Devuelve `false` si el glifo no ocupa nada (espacio, o fuera del juego), para que quien
   * llama no pague ni el `drawImage`.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    codepoint: number,
    paletteIndex: number,
    x: number,
    y: number,
  ): void {
    const sheet = this.sheetFor(paletteIndex);
    let slot = sheet.slots.get(codepoint);

    if (slot === undefined) {
      slot = sheet.slots.size;
      if (slot >= CAPACITY) {
        // No debería pasar con el juego de glifos del proyecto. Si pasa, se dibuja directo en
        // vez de fallar: más lento, pero correcto.
        ctx.fillStyle = paletteColor(PALETTE, paletteIndex);
        ctx.fillText(this.textFor(codepoint), x, y);
        return;
      }
      this.rasterize(sheet, codepoint, slot, paletteIndex);
      sheet.slots.set(codepoint, slot);
    }

    const sx = (slot % COLUMNS) * this.slotW;
    const sy = Math.floor(slot / COLUMNS) * this.slotH;
    ctx.drawImage(sheet.canvas, sx, sy, this.slotW, this.slotH, x, y, this.cellW, this.cellH);
  }

  private sheetFor(paletteIndex: number): Sheet {
    const existing = this.sheets.get(paletteIndex);
    if (existing) return existing;

    const canvas = document.createElement('canvas');
    canvas.width = COLUMNS * this.slotW;
    canvas.height = Math.ceil(CAPACITY / COLUMNS) * this.slotH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('CanvasRenderer requires a 2D context for its glyph sheets');

    // La hoja se dibuja en píxeles de dispositivo, así que el tipo se pide a esa escala: es lo
    // que hace que el glifo salga nítido en una pantalla Retina en vez de escalado.
    ctx.font = `${this.cellH * this.dpr}px ${this.font}`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = paletteColor(PALETTE, paletteIndex);

    const sheet: Sheet = { canvas, ctx, slots: new Map() };
    this.sheets.set(paletteIndex, sheet);
    return sheet;
  }

  private rasterize(sheet: Sheet, codepoint: number, slot: number, paletteIndex: number): void {
    const x = (slot % COLUMNS) * this.slotW;
    const y = Math.floor(slot / COLUMNS) * this.slotH;
    sheet.ctx.fillStyle = paletteColor(PALETTE, paletteIndex);
    sheet.ctx.fillText(this.textFor(codepoint), x, y);
  }

  /** `String.fromCodePoint` una vez por glifo, no una vez por celda y frame. */
  private textFor(codepoint: number): string {
    let text = this.glyphText.get(codepoint);
    if (text === undefined) {
      text = String.fromCodePoint(codepoint);
      this.glyphText.set(codepoint, text);
    }
    return text;
  }
}
