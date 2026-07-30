import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Grid, NO_CHROME, PAL } from '@glyphsphere/core';

/**
 * Lo que cuesta pintar un cuadro, contado en operaciones de canvas.
 *
 * No hay navegador acá, así que no se mide tiempo: se cuentan las llamadas, que es lo que
 * determina el tiempo y además no depende de la máquina. Las dos afirmaciones que sostienen el
 * rendimiento del backend son contables:
 *
 * 1. **Ningún `fillText` por celda.** Los glifos se copian de una hoja ya teñida. Un `fillText`
 *    hace medición y composición de texto; en una rejilla de terminal real son 20 000 por cuadro,
 *    y es por lo que la demo calentaba la máquina.
 * 2. **Un cuadro idéntico no repinta nada.** Solo se tocan las celdas que cambiaron.
 */

interface Counts {
  fillText: number;
  fillRect: number;
  drawImage: number;
}

let counts: Counts;

/** Un contexto 2D falso que solo cuenta. */
function fakeContext(tally: Counts): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textBaseline: '',
    globalAlpha: 1,
    lineWidth: 1,
    setTransform: () => {},
    fillRect: () => void tally.fillRect++,
    fillText: () => void tally.fillText++,
    drawImage: () => void tally.drawImage++,
    beginPath: () => {},
    ellipse: () => {},
    stroke: () => {},
    measureText: () => ({ width: 7 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    clearRect: () => {},
  } as unknown as CanvasRenderingContext2D;
}

/**
 * Las hojas teñidas se rasterizan con su propio contexto, y ese sí puede hacer `fillText`: una
 * vez por glifo y color, no una vez por celda. Se cuenta aparte para que la afirmación de arriba
 * signifique lo que dice.
 */
let sheetFillText = 0;

beforeEach(() => {
  counts = { fillText: 0, fillRect: 0, drawImage: 0 };
  sheetFillText = 0;

  let first = true;
  vi.stubGlobal('document', {
    createElement: () => {
      // El primero es el lienzo interno de la rejilla; el resto son hojas de glifos.
      const forGrid = first;
      first = false;
      return {
        width: 0,
        height: 0,
        style: {},
        getContext: () =>
          forGrid
            ? fakeContext(counts)
            : fakeContext({
                get fillText() {
                  return sheetFillText;
                },
                set fillText(n: number) {
                  sheetFillText = n;
                },
                fillRect: 0,
                drawImage: 0,
              } as Counts),
      };
    },
  });
  vi.stubGlobal('window', { devicePixelRatio: 2 });
});

/** Construye el renderer sobre un canvas falso. */
async function makeRenderer(cols: number, rows: number) {
  const { CanvasRenderer } = await import('../src/renderer.js');
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => fakeContext({ fillText: 0, fillRect: 0, drawImage: 0 }),
  } as unknown as HTMLCanvasElement;

  const renderer = new CanvasRenderer(canvas, { cellHeightPx: 14 });
  renderer.resize(cols, rows);
  return renderer;
}

/**
 * Una rejilla llena de braille, como el océano al que la cámara mira de cerca.
 *
 * El juego de glifos es el mismo para cualquier `seed` — 64 valores permutados — para que
 * cambiar la semilla mueva los glifos de sitio sin introducir ninguno nuevo.
 */
function filledGrid(cols: number, rows: number, seed = 0): Grid {
  const grid = new Grid(cols, rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      grid.set(x, y, 0x2800 + ((x * 7 + y * 13 + seed) % 64), PAL.CHROME, PAL.VOID);
    }
  }
  return grid;
}

describe('present', () => {
  it('no hace un fillText por celda: copia glifos ya rasterizados', async () => {
    const renderer = await makeRenderer(80, 24);
    const grid = filledGrid(80, 24);

    renderer.present(grid, NO_CHROME);

    expect(counts.fillText).toBe(0);
    expect(counts.drawImage).toBeGreaterThan(80 * 24 * 0.9);
  });

  it('cada glifo se rasteriza una sola vez, por mucho que reaparezca', async () => {
    const renderer = await makeRenderer(80, 24);

    // El primer cuadro paga la rasterización de los glifos que usa.
    renderer.present(filledGrid(80, 24), NO_CHROME);
    const afterFirst = sheetFillText;
    expect(afterFirst).toBeGreaterThan(0);

    // Los mismos glifos movidos de sitio: nada que rasterizar, solo copiar.
    renderer.present(filledGrid(80, 24, 7), NO_CHROME);
    expect(sheetFillText).toBe(afterFirst);
  });

  it('un cuadro idéntico no repinta ninguna celda', async () => {
    const renderer = await makeRenderer(80, 24);
    const grid = filledGrid(80, 24);

    renderer.present(grid, NO_CHROME);
    const afterFirst = { ...counts };

    renderer.present(grid, NO_CHROME);

    // Solo la copia final del lienzo a la pantalla; ni un glifo, ni un fondo.
    expect(counts.drawImage).toBe(afterFirst.drawImage);
    expect(counts.fillRect).toBe(afterFirst.fillRect);
  });

  it('repinta exactamente las celdas que cambiaron', async () => {
    const renderer = await makeRenderer(80, 24);
    const grid = filledGrid(80, 24);
    renderer.present(grid, NO_CHROME);
    const afterFirst = { ...counts };

    grid.set(5, 5, 0x2801, PAL.CHROME, PAL.VOID);
    grid.set(6, 5, 0x2802, PAL.CHROME, PAL.VOID);
    renderer.present(grid, NO_CHROME);

    expect(counts.drawImage - afterFirst.drawImage).toBe(2);
    // Cada celda que cambia repinta su fondo antes del glifo: si no, quedaría el de antes debajo.
    expect(counts.fillRect - afterFirst.fillRect).toBe(2);
  });

  it('una celda que se vacía borra el glifo que había', async () => {
    // Sin repintar el fondo de una celda que cambió, un glifo desaparecido seguiría en pantalla.
    const renderer = await makeRenderer(20, 5);
    const grid = filledGrid(20, 5);
    renderer.present(grid, NO_CHROME);
    const afterFirst = { ...counts };

    grid.set(3, 2, 32, PAL.CHROME, PAL.VOID);
    renderer.present(grid, NO_CHROME);

    expect(counts.fillRect - afterFirst.fillRect).toBe(1);
    expect(counts.drawImage - afterFirst.drawImage).toBe(0);
  });

  it('invalidate fuerza un repintado completo', async () => {
    const renderer = await makeRenderer(40, 10);
    const grid = filledGrid(40, 10);
    renderer.present(grid, NO_CHROME);
    const afterFirst = { ...counts };

    renderer.invalidate();
    renderer.present(grid, NO_CHROME);

    expect(counts.drawImage - afterFirst.drawImage).toBeGreaterThan(40 * 10 * 0.9);
  });

  it('cambiar de tamaño repinta todo, porque el lienzo se borró', async () => {
    const renderer = await makeRenderer(40, 10);
    renderer.present(filledGrid(40, 10), NO_CHROME);
    const afterFirst = { ...counts };

    renderer.resize(50, 12);
    renderer.present(filledGrid(50, 12), NO_CHROME);

    expect(counts.drawImage - afterFirst.drawImage).toBeGreaterThan(50 * 12 * 0.9);
  });
});
