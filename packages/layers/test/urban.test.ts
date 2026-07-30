import { describe, expect, it } from 'vitest';
import type { FeatureCollection, Geometry } from 'geojson';
import {
  Grid,
  LayerStack,
  MIN_ALT_KM,
  PAL,
  buildProjection,
  createCameraState,
  createPipeline,
  createViewMetrics,
  singleBodyScene,
  viewportHalfRows,
} from '@glyphsphere/core';
import { earth } from '@glyphsphere/bodies';
import { urbanLayer } from '../src/index.js';

/**
 * La capa urbana, contra geometría sintética a propósito: lo que se prueba es la capa, no el
 * dataset. `roads-10m` sale de `pnpm data:build` y puede no estar presente.
 */

const COLS = 160;
const ROWS = 48;
const CENTRE = { lon: -74.07, lat: 4.65 };

function collection(geometry: Geometry, scalerank: number): FeatureCollection<Geometry> {
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { scalerank }, geometry }],
  };
}

/** Una línea este-oeste que pasa por el centro de la vista. */
function road(spanDeg: number, scalerank = 3): FeatureCollection<Geometry> {
  return collection(
    {
      type: 'LineString',
      coordinates: [
        [CENTRE.lon - spanDeg, CENTRE.lat],
        [CENTRE.lon + spanDeg, CENTRE.lat],
      ],
    },
    scalerank,
  );
}

/** Un cuadrado alrededor del centro de la vista. */
function urbanArea(spanDeg: number): FeatureCollection<Geometry> {
  const { lon, lat } = CENTRE;
  return collection(
    {
      type: 'Polygon',
      coordinates: [
        [
          [lon - spanDeg, lat - spanDeg],
          [lon + spanDeg, lat - spanDeg],
          [lon + spanDeg, lat + spanDeg],
          [lon - spanDeg, lat + spanDeg],
          [lon - spanDeg, lat - spanDeg],
        ],
      ],
    },
    1,
  );
}

/** Cuenta celdas braille por color. Braille es el registro que `reduce` usa para linework. */
function brailleByColour(
  altitudeKm: number,
  options: Parameters<typeof urbanLayer>[0],
): Map<number, number> {
  const view = createViewMetrics(COLS, ROWS);
  const grid = new Grid(COLS, ROWS);
  const pipeline = createPipeline(COLS, ROWS);
  const stack = new LayerStack([urbanLayer(options)]);
  const camera = createCameraState(earth.id, { ...CENTRE, altitudeKm });

  pipeline.render({ scene: singleBodyScene(earth), camera, view, grid, stack });

  const counts = new Map<number, number>();
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = grid.get(x, y);
      if (cell.glyph >= 0x2800 && cell.glyph <= 0x28ff) {
        counts.set(cell.fg, (counts.get(cell.fg) ?? 0) + 1);
      }
    }
  }
  return counts;
}

describe('urbanLayer', () => {
  it('dibuja una vía como linework ROAD, en braille y en CHROME', () => {
    const counts = brailleByColour(20, { roads: road(0.3) });
    expect(counts.get(PAL.CHROME) ?? 0).toBeGreaterThan(0);
  });

  it('no dibuja nada por encima de su escala', () => {
    // 400 km está muy por encima del techo de 150 km: una autopista a esa altitud sería una
    // raya sobre medio país, que es exactamente lo que el umbral existe para evitar.
    const counts = brailleByColour(400, { roads: road(0.3) });
    expect(counts.get(PAL.CHROME) ?? 0).toBe(0);
  });

  it('respeta la jerarquía de scalerank a medida que la cámara baja', () => {
    // A 100 km solo entra rank <= 3; a 20 km se abre hasta 5.
    const alto = brailleByColour(100, { roads: road(0.3, 5) });
    const bajo = brailleByColour(20, { roads: road(0.3, 5) });
    expect(alto.get(PAL.CHROME) ?? 0).toBe(0);
    expect(bajo.get(PAL.CHROME) ?? 0).toBeGreaterThan(0);
  });

  it('una troncal de rank 3 se ve a toda la escala de la capa', () => {
    for (const altitudeKm of [150, 60, 10]) {
      expect(brailleByColour(altitudeKm, { roads: road(0.3, 3) }).get(PAL.CHROME) ?? 0).
        toBeGreaterThan(0);
    }
  });

  it('distingue la huella construida de la vía por color', () => {
    const counts = brailleByColour(20, { roads: road(0.3), urbanAreas: urbanArea(0.15) });
    expect(counts.get(PAL.CHROME) ?? 0).toBeGreaterThan(0);
    expect(counts.get(PAL.NIGHTLIT) ?? 0).toBeGreaterThan(0);
  });

  it('no rellena el interior de la huella: una ciudad no cambia la altura del terreno', () => {
    const soloHuella = brailleByColour(20, { urbanAreas: urbanArea(0.15) });
    // Solo el contorno, así que el conteo es del orden del perímetro, no del área.
    const perimetroCeldas = soloHuella.get(PAL.NIGHTLIT) ?? 0;
    expect(perimetroCeldas).toBeGreaterThan(0);
    expect(perimetroCeldas).toBeLessThan(COLS * ROWS * 0.25);
  });
});

/**
 * El alcance real del zoom, fijado.
 *
 * Este bloque existía antes para documentar un **piso**: con el encuadre atado al horizonte, la
 * celda no bajaba de ~1.6 km ni en la altitud mínima, y la vista de calle era inalcanzable. El
 * campo de visión (`ViewMetrics.fovDeg`) quitó ese piso, y estos números lo pinchan en su sitio —
 * si alguien vuelve a atar el encuadre al horizonte, esto lo dice en voz alta.
 */
describe('alcance del zoom', () => {
  const view = createViewMetrics(COLS, ROWS);

  const metersPerCell = (altitudeKm: number): number =>
    buildProjection(
      earth,
      createCameraState(earth.id, { ...CENTRE, altitudeKm }),
      view,
    ).metersPerCell();

  it('en la altitud mínima una celda mide metros, no kilómetros', () => {
    // MIN_ALT_KM son 200 m. Una cuadra son ~100 m: a esta escala una cuadra ocupa varias celdas,
    // que es lo que "nivel de calle" quería decir desde el principio.
    const m = metersPerCell(MIN_ALT_KM);
    expect(m).toBeLessThan(30);
    expect(m).toBeGreaterThan(0);
  });

  it('la escala sigue a la altitud en todo el rango, sin estancarse', () => {
    // Cada escalón divide la altitud por 10; la escala tiene que seguirle el paso. Antes del
    // campo de visión, de 2000 km a 0.2 km la altitud caía 10 000x y la escala solo 89x.
    const alturas = [2_000, 200, 20, 2, 0.2];
    const escalas = alturas.map(metersPerCell);

    for (let i = 1; i < escalas.length; i++) {
      const factor = escalas[i - 1]! / escalas[i]!;
      expect(factor).toBeGreaterThan(5);
    }

    const rangoAltitud = alturas[0]! / alturas.at(-1)!;
    const rangoEscala = escalas[0]! / escalas.at(-1)!;
    expect(rangoEscala).toBeGreaterThan(rangoAltitud * 0.5);
  });

  it('la escala es monótona: bajar nunca aleja', () => {
    let previa = Infinity;
    for (const altitudeKm of [80_000, 20_000, 6_371, 2_000, 400, 30, 1, MIN_ALT_KM]) {
      const m = metersPerCell(altitudeKm);
      expect(m).toBeLessThan(previa);
      previa = m;
    }
  });

  it('desde órbita alta se sigue viendo el planeta entero', () => {
    // El campo de visión no debe romper la vista de globo: por encima del cruce el cuerpo cabe
    // en el cuadro y el limbo queda dentro del viewport.
    const p = buildProjection(
      earth,
      createCameraState(earth.id, { ...CENTRE, altitudeKm: 20_000 }),
      view,
    );
    expect(p.radiusRows).toBeCloseTo(viewportHalfRows(view), 6);
  });
});
