/**
 * The sample buffer: where geometry layers declare what is where, at braille subcell
 * resolution, before any character has been chosen. docs/RENDERING.md, paso 1.
 *
 * Two deliberate departures from the doc, both forced by CLAUDE.md's "core no toca el DOM":
 *
 * 1. **No offscreen canvas.** The doc describes painting to a canvas and reading it back with
 *    one `getImageData`. Canvas is unavailable in Node and React Native, which would take the
 *    plain-text visual snapshot suite — the project's stated safety net — with it. So geometry
 *    is rasterized here in plain typed arrays instead. The pipeline stages are unchanged.
 * 2. **Planar channels, not interleaved RGBA.** RGBA packing existed to match `getImageData`.
 *    With no canvas in the path the channels are separate arrays; the *semantics* of the four
 *    channels are exactly as documented.
 *
 * There is also one addition: `bodyMask`, the body silhouette. Without it a cell of open ocean
 * and a cell of empty space are indistinguishable (both have zero coverage). The silhouette is
 * not layer data — it follows from the projection — so the pipeline fills it, not a layer.
 */

/** Subcell resolution. 2x4 is the braille cell, which makes pattern extraction a direct read. */
export const SUB_X = 2;
export const SUB_Y = 4;

/**
 * Line feature classes, written to the `lineClass` channel. The class picks the colour; the
 * glyph is `reduce`'s decision, never the layer's (docs/API.md).
 */
export const LINE_CLASS = {
  NONE: 0,
  COAST: 1,
  RIVER: 2,
  CONTOUR: 3,
  /** Every fifth contour: drawn brighter, the cartographic convention. */
  CONTOUR_MASTER: 7,
  BORDER: 4,
  ROAD: 5,
  GRATICULE: 6,
  /** Edge of a built-up area. Context under the roads, so it reads dimmer than one. */
  URBAN: 8,
  CUSTOM_1: 200,
  CUSTOM_2: 201,
} as const;

export type LineClass = (typeof LINE_CLASS)[keyof typeof LINE_CLASS];

/** A subcell channel. Masks are bytes; elevation is signed metres. */
export type SampleChannel = Uint8Array | Int16Array;

export interface SampleBuffer {
  readonly cols: number;
  readonly rows: number;
  readonly subX: number;
  readonly subY: number;
  readonly width: number;
  readonly height: number;

  /** R: area coverage. 0 = not covered, 255 = covered. */
  readonly coverage: Uint8Array;
  /**
   * G: ground height in **metres**, signed. Not a normalized byte.
   *
   * A byte was the original design, normalized over the body's elevation range. On Earth that
   * range is 17 274 m, so a byte is 67.7 m per step — and sea level fell *inside* a step that
   * reconstructed to -13.1 m. Every real elevation from 0 to 55 m came back negative and drew
   * the water band, which is why Miami, New York, Shanghai and the whole Dutch coast rendered
   * as ocean. Metres in an Int16 cost one extra byte per subcell and resolve 1 m, which is
   * also what makes docs/RELIEF.md's finest contour interval (20 m) representable at all.
   */
  readonly elevation: Int16Array;
  /** B: linear feature mask. Non-zero means a line passes through this subcell. */
  readonly lineMask: Uint8Array;
  /** A: which class of line. Not an alpha channel — an index. */
  readonly lineClass: Uint8Array;
  /** Body silhouette: is this subcell on the body at all, or is it space? */
  readonly bodyMask: Uint8Array;

  clear(): void;
}

export function createSampleBuffer(cols: number, rows: number): SampleBuffer {
  const width = cols * SUB_X;
  const height = rows * SUB_Y;
  const size = width * height;

  const coverage = new Uint8Array(size);
  const elevation = new Int16Array(size);
  const lineMask = new Uint8Array(size);
  const lineClass = new Uint8Array(size);
  const bodyMask = new Uint8Array(size);

  return {
    cols,
    rows,
    subX: SUB_X,
    subY: SUB_Y,
    width,
    height,
    coverage,
    elevation,
    lineMask,
    lineClass,
    bodyMask,
    clear() {
      coverage.fill(0);
      elevation.fill(0);
      lineMask.fill(0);
      lineClass.fill(0);
      bodyMask.fill(0);
    },
  };
}

/**
 * Collects the polygons d3's path stream emits. d3 does the hard parts — clipping to the
 * visible cap, the antimeridian, adaptive resampling — and hands us plain screen-space rings.
 *
 * Implements the slice of CanvasRenderingContext2D that d3-geo's path actually calls.
 */
export class PathSink {
  /** Flat [x0, y0, x1, y1, ...] per ring. */
  private readonly rings: number[][] = [];
  /**
   * Whether each ring was closed, parallel to `rings`. d3 calls `closePath()` for polygon
   * boundaries and does not for linestrings, so this records the answer instead of making
   * callers guess it. Getting it wrong joins the ends of every open coastline, which draws
   * straight lines across the whole body.
   */
  private readonly closedFlags: boolean[] = [];
  private current: number[] | null = null;

  constructor(
    private readonly correctX: number,
    private readonly centreX: number,
  ) {}

  private fx(x: number): number {
    return this.correctX === 1 ? x : this.centreX + (x - this.centreX) * this.correctX;
  }

  beginPath(): void {
    this.rings.length = 0;
    this.closedFlags.length = 0;
    this.current = null;
  }

  moveTo(x: number, y: number): void {
    this.current = [this.fx(x), y];
    this.rings.push(this.current);
    this.closedFlags.push(false);
  }

  lineTo(x: number, y: number): void {
    this.current?.push(this.fx(x), y);
  }

  closePath(): void {
    if (this.current) this.closedFlags[this.rings.length - 1] = true;
    this.current = null;
  }

  /** d3 calls this for Point geometries. Geometry layers declare areas and lines, not points. */
  arc(): void {}

  get result(): readonly number[][] {
    return this.rings;
  }

  /** Per-ring closed flags, index-aligned with `result`. */
  get closed(): readonly boolean[] {
    return this.closedFlags;
  }
}

/**
 * Scratch buffers for the fill. Reused across calls and grown on demand, because
 * docs/RENDERING.md requires zero allocation inside the render loop.
 */
let edgeYTop = new Float64Array(0);
let edgeYBot = new Float64Array(0);
let edgeX = new Float64Array(0);
let edgeSlope = new Float64Array(0);
let edgeWinding = new Int8Array(0);
let edgeOrder = new Int32Array(0);
let activeEdges = new Int32Array(0);
let crossings = new Float64Array(0);
let crossingWinding = new Int8Array(0);
let crossingOrder = new Int32Array(0);

function ensureEdgeCapacity(count: number): void {
  if (edgeYTop.length >= count) return;
  const size = Math.max(count, edgeYTop.length * 2, 1024);
  edgeYTop = new Float64Array(size);
  edgeYBot = new Float64Array(size);
  edgeX = new Float64Array(size);
  edgeSlope = new Float64Array(size);
  edgeWinding = new Int8Array(size);
  edgeOrder = new Int32Array(size);
  activeEdges = new Int32Array(size);
  crossings = new Float64Array(size);
  crossingWinding = new Int8Array(size);
  crossingOrder = new Int32Array(size);
}

/** Sorts crossing indices by x. Hoisted so the sweep allocates no closures. */
const byCrossingX = (a: number, b: number): number => crossings[a]! - crossings[b]!;

/**
 * Nonzero-winding scanline fill of the collected rings, with an active edge table.
 *
 * **Nonzero, not even-odd.** GeoJSON gives holes the opposite orientation to their outer ring,
 * and d3's spherical clipping preserves that — which is exactly why rendering d3 paths to a
 * canvas with the default `ctx.fill()` works. Parity looks equivalent and is not: when the
 * camera sits inside a landmass, d3 emits the clip circle once per containing polygon, and two
 * same-direction rings cancel under parity. The symptom is the whole view flipping to ocean
 * once you descend into the middle of a continent.
 *
 * The AET is not premature optimization — the naive O(scanlines x edges) version measured
 * 45 ms per frame on land-50m against a 3.5 ms budget. Sorting edges by their top and keeping
 * only the ones the scanline actually crosses makes the cost proportional to real crossings.
 */
export function fillRings(
  rings: readonly (readonly number[])[],
  target: SampleChannel,
  width: number,
  height: number,
  value = 255,
): void {
  if (rings.length === 0) return;

  let total = 0;
  for (const ring of rings) total += ring.length >> 1;
  if (total === 0) return;
  ensureEdgeCapacity(total + 1);

  // --- Build the edge table ---------------------------------------------------------
  let count = 0;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 6) continue; // fewer than three points cannot enclose area

    let x0 = ring[n - 2]!;
    let y0 = ring[n - 1]!;
    for (let i = 0; i < n; i += 2) {
      const x1 = ring[i]!;
      const y1 = ring[i + 1]!;

      // Horizontal edges never cross a scanline, and would divide by zero.
      if (y0 !== y1) {
        const slope = (x1 - x0) / (y1 - y0);
        if (y0 < y1) {
          edgeYTop[count] = y0;
          edgeYBot[count] = y1;
          edgeX[count] = x0;
          edgeWinding[count] = 1; // downward
        } else {
          edgeYTop[count] = y1;
          edgeYBot[count] = y0;
          edgeX[count] = x1;
          edgeWinding[count] = -1; // upward
        }
        edgeSlope[count] = slope;
        count++;
      }

      x0 = x1;
      y0 = y1;
    }
  }
  if (count === 0) return;

  // Indices sorted by the scanline each edge becomes active on.
  const order = edgeOrder.subarray(0, count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => edgeYTop[a]! - edgeYTop[b]!);

  // --- Sweep ------------------------------------------------------------------------
  let next = 0;
  let activeCount = 0;

  for (let y = 0; y < height; y++) {
    const scanY = y + 0.5;

    // An edge spans [yTop, yBot): a vertex sitting exactly on the scanline counts once.
    while (next < count && edgeYTop[order[next]!]! <= scanY) {
      activeEdges[activeCount++] = order[next++]!;
    }

    let crossingCount = 0;
    let kept = 0;
    for (let i = 0; i < activeCount; i++) {
      const edge = activeEdges[i]!;
      if (edgeYBot[edge]! <= scanY) continue; // expired; drop it
      activeEdges[kept++] = edge;
      crossings[crossingCount] = edgeX[edge]! + (scanY - edgeYTop[edge]!) * edgeSlope[edge]!;
      crossingWinding[crossingCount] = edgeWinding[edge]!;
      crossingCount++;
    }
    activeCount = kept;

    if (crossingCount < 2) continue;

    // Sort an index permutation so each crossing keeps its winding direction.
    const sorted = crossingOrder.subarray(0, crossingCount);
    for (let i = 0; i < crossingCount; i++) sorted[i] = i;
    sorted.sort(byCrossingX);

    // Walk left to right accumulating winding; the interior is wherever it is non-zero.
    const rowStart = y * width;
    let winding = 0;
    for (let i = 0; i + 1 < crossingCount; i++) {
      winding += crossingWinding[sorted[i]!]!;
      if (winding === 0) continue;

      const from = Math.max(0, Math.ceil(crossings[sorted[i]!]! - 0.5));
      const to = Math.min(width - 1, Math.floor(crossings[sorted[i + 1]!]! - 0.5));
      for (let x = from; x <= to; x++) target[rowStart + x] = value;
    }
  }
}

/** Stamps one subcell into the line channels. */
function plot(
  mask: Uint8Array,
  classes: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  lineClass: number,
): void {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const i = y * width + x;
  mask[i] = 255;
  // Later classes win the tie; layer order already encodes which line matters more.
  classes[i] = lineClass;
}

/**
 * Draws the ring outlines into the line channels. Width is in **subcells**, never pixels — a
 * layer describes how thick a feature is in the geometry's own terms (docs/API.md).
 *
 * `closedFlags` says, per ring, whether the path closes back on its first point. Pass the
 * flags `PathSink` collected; omitting them treats every path as open, which is the safe
 * default — a missing closing segment is invisible, an invented one is a line across the map.
 */
export function strokeRings(
  rings: readonly (readonly number[])[],
  mask: Uint8Array,
  classes: Uint8Array,
  width: number,
  height: number,
  lineClass: number,
  widthSubcells = 1,
  closedFlags: readonly boolean[] = [],
): void {
  const spread = Math.max(0, Math.floor((widthSubcells - 1) / 2));

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    const n = ring.length;
    if (n < 4) continue;

    const closed = closedFlags[r] ?? false;

    // A closed ring starts from the last point, so the wrap-around segment gets drawn; an open
    // path starts from its first point. Both then consume every remaining point.
    let x0 = closed ? ring[n - 2]! : ring[0]!;
    let y0 = closed ? ring[n - 1]! : ring[1]!;
    const start = closed ? 0 : 2;

    for (let i = start; i < n; i += 2) {
      const x1 = ring[i]!;
      const y1 = ring[i + 1]!;
      plotSegment(mask, classes, width, height, x0, y0, x1, y1, lineClass, spread);
      x0 = x1;
      y0 = y1;
    }
  }
}

function plotSegment(
  mask: Uint8Array,
  classes: Uint8Array,
  width: number,
  height: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  lineClass: number,
  spread: number,
): void {
  // Bresenham on rounded subcell coordinates. Sub-cell precision is not lost: it lives in
  // *which* of the 2x4 subcells get set, which is exactly the braille pattern.
  let x = Math.round(ax);
  let y = Math.round(ay);
  const x1 = Math.round(bx);
  const y1 = Math.round(by);

  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx + dy;

  // A wildly long segment means the projection produced something degenerate; bail rather
  // than spin. The diagonal of the buffer is the most any sane segment can span.
  let guard = width + height + 4;

  for (;;) {
    if (spread === 0) {
      plot(mask, classes, width, height, x, y, lineClass);
    } else {
      for (let oy = -spread; oy <= spread; oy++) {
        for (let ox = -spread; ox <= spread; ox++) {
          plot(mask, classes, width, height, x + ox, y + oy, lineClass);
        }
      }
    }

    if ((x === x1 && y === y1) || guard-- <= 0) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}
