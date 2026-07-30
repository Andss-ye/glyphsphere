import { describe, expect, it } from 'vitest';
import { geoDistance } from 'd3-geo';
import {
  Grid,
  LayerStack,
  LINE_CLASS,
  MIN_ALT_KM,
  PAL,
  SUB_X,
  buildProjection,
  createCameraState,
  createPipeline,
  createSampleBuffer,
  createSampleContext,
  createViewMetrics,
  paintBodySilhouette,
  singleBodyScene,
} from '@glyphsphere/core';
import { earth } from '@glyphsphere/bodies';
import type { MultiLineString, Position } from 'geojson';
import {
  SIMPLIFY_M,
  capIsVisible,
  decodeStreets,
  encodeStreets,
  resolveLine,
  simplifyQuantized,
  streetsLayer,
  tileAt,
  viewCap,
  type EncodableWay,
  type StreetsMeta,
} from '../src/index.js';

/**
 * Calles reales en braille — la capa que cierra el zoom.
 *
 * Se prueba contra un tile sintético construido acá, no contra el asset: `pnpm data:build`
 * descarga de OpenStreetMap y puede no haber corrido. Lo que se verifica es el contrato del
 * formato y de la capa, que es lo que se rompe en silencio.
 *
 * El tile se arma con el **codificador real**, no con una copia del layout: el formato ya se
 * escribió dos veces una vez, y la copia del test es exactamente donde una divergencia pasa
 * desapercibida.
 */

const CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'living_street',
  'pedestrian',
  'water',
  'stream',
];
const WATER_CLASS = 9;
const STREAM_CLASS = 10;

const BBOX = [-74.21, 4.51, -73.93, 4.79] as const;

const meta: StreetsMeta = {
  classes: CLASSES,
  waterClass: WATER_CLASS,
  tiles: [{ id: 't', name: 'Prueba', file: 't.bin.gz', bbox: BBOX }],
};

function encode(ways: readonly EncodableWay[]): Uint8Array {
  return encodeStreets(ways, BBOX, CLASSES.length, earth.radiusKm).bytes;
}

function decodeOne(ways: readonly EncodableWay[]) {
  return decodeStreets(encode(ways), meta, meta.tiles[0]!);
}

/** Una calle recta de `count` puntos entre dos esquinas. */
function segment(
  classIndex: number,
  from: readonly [number, number],
  to: readonly [number, number],
  count = 24,
): EncodableWay {
  const points = Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t] as [number, number];
  });
  return { classIndex, points };
}

/** Una calle que serpentea, para que la simplificación tenga algo que conservar. */
function winding(
  classIndex: number,
  from: readonly [number, number],
  to: readonly [number, number],
  count = 40,
  amplitudeDeg = 0.002,
): EncodableWay {
  const points = Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    return [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t + amplitudeDeg * Math.sin(t * Math.PI * 6),
    ] as [number, number];
  });
  return { classIndex, points };
}

const CENTRE = { lon: -74.07, lat: 4.65 };

describe('el formato binario de calles', () => {
  it('rechaza bytes que no son un tile', () => {
    expect(() => decodeStreets(new Uint8Array(64), meta, meta.tiles[0]!)).toThrow(/streets tile/);
  });

  it('rechaza un asset de otra versión en vez de malinterpretarlo', () => {
    // Sin esto un asset viejo no da error: da geometría plausible y falsa, que es la peor forma
    // de fallar que tiene un mapa.
    const bytes = encode([segment(0, [-74.1, 4.6], [-74.0, 4.7])]);
    new DataView(bytes.buffer).setUint16(4, 1, true);
    expect(() => decodeStreets(bytes, meta, meta.tiles[0]!)).toThrow(/version 1/);
  });

  it('reconstruye las coordenadas dentro de la resolución que promete', () => {
    // Cuantización de 1 m más simplificación de 2 m: el error total tiene que quedar por debajo
    // de la subcelda más fina que la cámara dibuja, que son 2 m a 4 m por celda.
    const original = winding(0, [-74.1, 4.6], [-74.0, 4.7], 60);
    const decoded = decodeOne([original]).roads[0]!.ring.coordinates;

    // Cada punto conservado tiene que estar donde estaba: se busca el original más cercano.
    let worstM = 0;
    for (const point of decoded) {
      let nearest = Infinity;
      for (const [lon, lat] of original.points) {
        nearest = Math.min(
          nearest,
          geoDistance([lon, lat], [point[0]!, point[1]!]) * earth.radiusKm * 1000,
        );
      }
      worstM = Math.max(worstM, nearest);
    }
    expect(worstM).toBeLessThan(SIMPLIFY_M);
  });

  it('sobrevive a deltas grandes y negativos en los dos sentidos', () => {
    // El zigzag varint es donde un error de signo o de acarreo se vuelve geometría torcida sin
    // que nada falle. Una vía en zigzag de esquina a esquina los ejercita todos.
    // Cada punto se aparta de la recta que une los extremos, si no la simplificación lo descarta
    // con razón y el test no llega a ejercitar la codificación.
    const points: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      points.push(
        i % 2 === 0
          ? [BBOX[0] + 0.001 + t * 0.01, BBOX[1] + 0.001]
          : [BBOX[2] - 0.001 - t * 0.01, BBOX[3] - 0.001],
      );
    }
    const decoded = decodeOne([{ classIndex: 0, points }]).roads[0]!.ring.coordinates;

    expect(decoded.length).toBe(points.length);
    for (let i = 0; i < points.length; i++) {
      const d = geoDistance(points[i]!, [decoded[i]![0]!, decoded[i]![1]!]) * earth.radiusKm * 1000;
      expect(d).toBeLessThan(SIMPLIFY_M);
    }
  });

  it('recorta al cuadro en vez de desbordar la cuantización', () => {
    // Overpass devuelve la vía entera si toca el cuadro, así que llegan puntos de fuera.
    const tile = decodeOne([segment(0, [-75.5, 3.0], [-73.95, 4.77], 40)]);
    for (const [lon, lat] of tile.roads[0]!.ring.coordinates) {
      expect(lon!).toBeGreaterThanOrEqual(BBOX[0] - 1e-6);
      expect(lon!).toBeLessThanOrEqual(BBOX[2] + 1e-6);
      expect(lat!).toBeGreaterThanOrEqual(BBOX[1] - 1e-6);
      expect(lat!).toBeLessThanOrEqual(BBOX[3] + 1e-6);
    }
  });

  it('conserva la clase de cada vía y separa el agua', () => {
    const tile = decodeOne([
      segment(0, [-74.1, 4.6], [-74.0, 4.6]),
      segment(5, [-74.1, 4.62], [-74.0, 4.62]),
      segment(WATER_CLASS, [-74.1, 4.64], [-74.0, 4.64]),
      segment(STREAM_CLASS, [-74.1, 4.66], [-74.0, 4.66]),
    ]);
    expect(tile.roads.map((s) => s.classIndex)).toEqual([0, 5]);
    expect(tile.water.map((s) => s.classIndex)).toEqual([WATER_CLASS, STREAM_CLASS]);
    expect(tile.majorWaterClass).toBe(WATER_CLASS);
  });

  it('encuentra el tile que contiene un punto, y solo ese', () => {
    expect(tileAt(meta.tiles, CENTRE.lon, CENTRE.lat)?.id).toBe('t');
    expect(tileAt(meta.tiles, 2.35, 48.85)).toBeUndefined();
  });
});

describe('simplifyQuantized', () => {
  it('conserva los extremos', () => {
    const points = Array.from({ length: 50 }, (_, i) => [i, (i * 7) % 13] as const);
    const out = simplifyQuantized(points, 3);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);
  });

  it('colapsa una recta a sus dos extremos', () => {
    const points = Array.from({ length: 100 }, (_, i) => [i * 3, i * 3] as const);
    expect(simplifyQuantized(points, 2)).toHaveLength(2);
  });

  it('ningún punto descartado se aparta más que la tolerancia', () => {
    const points = Array.from(
      { length: 200 },
      (_, i) => [i, Math.round(20 * Math.sin(i / 9))] as const,
    );
    const kept = simplifyQuantized(points, 4);
    expect(kept.length).toBeLessThan(points.length);

    // Distancia de cada original a la polilínea simplificada.
    for (const [px, py] of points) {
      let best = Infinity;
      for (let i = 1; i < kept.length; i++) {
        const [ax, ay] = kept[i - 1]!;
        const [bx, by] = kept[i]!;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
      }
      expect(best).toBeLessThanOrEqual(4 + 1e-9);
    }
  });

  it('no revienta la pila con una vía muy larga', () => {
    /**
     * Douglas-Peucker recursivo desborda con miles de puntos, y una avenida encadenada de OSM los
     * tiene. Es iterativo por eso.
     *
     * La sierra es el peor caso a propósito: ningún punto se puede descartar, así que cada
     * partición avanza de a uno y la profundidad iguala al número de puntos — que es justo lo que
     * la versión recursiva no sobrevive. 8 000 ya está muy por encima del límite de pila de V8.
     */
    const points = Array.from({ length: 8_000 }, (_, i) => [i, i % 2] as const);
    expect(() => simplifyQuantized(points, 0.5)).not.toThrow();
  });
});

const COLS = 160;
const ROWS = 48;

/** Cuenta celdas braille por color: braille es el registro que `reduce` da al linework. */
function brailleByColour(altitudeKm: number, ways: readonly EncodableWay[]) {
  const view = createViewMetrics(COLS, ROWS);
  const grid = new Grid(COLS, ROWS);
  const pipeline = createPipeline(COLS, ROWS);
  const stack = new LayerStack([streetsLayer({ tiles: [decodeOne(ways)] })]);
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

/**
 * Altitud que da aproximadamente esa escala en esta rejilla.
 *
 * Los tests hablan de **metros por celda**, no de kilómetros de altitud, porque eso es lo que la
 * capa decide. Atarlos a una altitud concreta los hace depender del tamaño de la rejilla y del
 * campo de visión: la primera versión afirmaba cosas a "20 km" que dejaron de ser ciertas al
 * cambiar el relevo con los contornos, sin que la capa estuviera mal.
 */
function altitudeForScale(metersPerCell: number): number {
  const view = createViewMetrics(COLS, ROWS);
  const at = (altitudeKm: number): number =>
    buildProjection(earth, createCameraState(earth.id, { ...CENTRE, altitudeKm }), view)
      .metersPerCell();

  let low = MIN_ALT_KM;
  let high = 2_000;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (at(mid) > metersPerCell) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}

/** Una calle corta que cruza el centro de la vista. */
const CRUZA = (classIndex: number) =>
  segment(classIndex, [CENTRE.lon - 0.004, CENTRE.lat], [CENTRE.lon + 0.004, CENTRE.lat], 30);

describe('streetsLayer', () => {
  it('dibuja una calle en braille, no en otro registro', () => {
    expect(brailleByColour(1, [CRUZA(0)]).get(PAL.CHROME) ?? 0).toBeGreaterThan(0);
  });

  it('no dibuja nada por encima de su escala', () => {
    // A 2 km por celda una calle mide una fracción de subcelda: dibujarla sería inventar detalle,
    // y a esa escala el relevo lo tiene el relieve del terreno.
    expect(brailleByColour(altitudeForScale(2_000), [CRUZA(0)]).get(PAL.CHROME) ?? 0).toBe(0);
  });

  it('abre la jerarquía a medida que la cámara baja', () => {
    // Una residencial no entra hasta que la celda baja de ~18 m; una arteria se ve mucho antes.
    const arterial = altitudeForScale(200);
    const barrio = altitudeForScale(10);

    expect(brailleByColour(arterial, [CRUZA(5)]).get(PAL.CHROME) ?? 0).toBe(0);
    expect(brailleByColour(barrio, [CRUZA(5)]).get(PAL.CHROME) ?? 0).toBeGreaterThan(0);
    expect(brailleByColour(arterial, [CRUZA(0)]).get(PAL.CHROME) ?? 0).toBeGreaterThan(0);
  });

  it('el agua se dibuja como agua, no como calzada', () => {
    const counts = brailleByColour(1, [
      CRUZA(0),
      segment(
        WATER_CLASS,
        [CENTRE.lon - 0.004, CENTRE.lat + 0.002],
        [CENTRE.lon + 0.004, CENTRE.lat + 0.002],
        30,
      ),
    ]);
    expect(counts.get(PAL.CHROME) ?? 0).toBeGreaterThan(0);
    expect(counts.get(PAL.SHELF) ?? 0).toBeGreaterThan(0);
  });

  it('un río no queda sujeto al umbral de jerarquía vial', () => {
    // A escala arterial solo entran calzadas de clase <= 2, pero un río sigue siendo un río.
    const river = segment(
      WATER_CLASS,
      [CENTRE.lon - 0.02, CENTRE.lat],
      [CENTRE.lon + 0.02, CENTRE.lat],
      40,
    );
    expect(brailleByColour(altitudeForScale(200), [river]).get(PAL.SHELF) ?? 0).toBeGreaterThan(0);
  });

  it('una quebrada sí espera a que la celda sea fina', () => {
    /**
     * El agua no sigue la jerarquía vial, pero "agua" en OSM incluye el drenaje de tres metros.
     * Medido sobre Bogotá a 419 m por celda, los cauces menores emitían más puntos que todas las
     * calzadas juntas — la mitad del frame en algo que no cubría ni una subcelda.
     */
    const stream = segment(
      STREAM_CLASS,
      [CENTRE.lon - 0.02, CENTRE.lat],
      [CENTRE.lon + 0.02, CENTRE.lat],
      40,
    );
    expect(brailleByColour(altitudeForScale(200), [stream]).get(PAL.SHELF) ?? 0).toBe(0);
    expect(brailleByColour(altitudeForScale(40), [stream]).get(PAL.SHELF) ?? 0).toBeGreaterThan(0);
  });

  it('cede el paso al terreno por encima de su escala', () => {
    // El relevo con los contornos: el pipeline los calla por debajo de ~612 m por celda, y la capa
    // de calles arranca justo ahí. Solaparlos sumaba 60 % de contornos y 36 % de calles en el mismo
    // cuadro, sobre Bogotá a 20 km.
    expect(brailleByColour(altitudeForScale(900), [CRUZA(0)]).get(PAL.CHROME) ?? 0).toBe(0);
    expect(brailleByColour(altitudeForScale(300), [CRUZA(0)]).get(PAL.CHROME) ?? 0).toBeGreaterThan(0);
  });

  it('una retícula de calles produce braille en muchas celdas, no en una raya', () => {
    // Lo que hace realista una ciudad es la trama. Doce calles cruzadas tienen que ocupar el
    // cuadro, que es la diferencia entre "hay datos" y "se ve la ciudad".
    const ways: EncodableWay[] = [];
    for (let i = 0; i < 6; i++) {
      const d = -0.005 + i * 0.002;
      ways.push(segment(5, [CENTRE.lon - 0.006, CENTRE.lat + d], [CENTRE.lon + 0.006, CENTRE.lat + d], 20));
      ways.push(segment(5, [CENTRE.lon + d, CENTRE.lat - 0.006], [CENTRE.lon + d, CENTRE.lat + 0.006], 20));
    }
    expect(brailleByColour(1, ways).get(PAL.CHROME) ?? 0).toBeGreaterThan(100);
  });
});

/**
 * `strokeLine(..., dense)` apaga el resampleo adaptativo de d3, y eso solo es legítimo si el
 * cuadro sale idéntico. No es una suposición razonable: la simplificación al hornear colapsa una
 * avenida recta a dos puntos separados kilómetros, así que la premisa ingenua — "los vértices
 * están más juntos que una subcelda" — es falsa. Lo que la hace exacta es la **extensión del
 * parche**, no la separación dentro de él.
 *
 * Este test es el que sostiene esa afirmación, y el que la rompería si alguien subiera
 * `maxMetersPerCell` hasta donde el parche deje de ser afín.
 */
describe('el atajo de resampleo no cambia el cuadro', () => {
  it('produce las mismas subceldas que el camino resampleado, a toda escala', () => {
    const ways: EncodableWay[] = [];
    for (let i = 0; i < 20; i++) {
      const d = -0.05 + i * 0.005;
      // Rectas largas (que la simplificación colapsa a dos puntos) y curvas, mezcladas.
      ways.push(segment(i % 3, [CENTRE.lon - 0.06, CENTRE.lat + d], [CENTRE.lon + 0.06, CENTRE.lat + d], 30));
      ways.push(winding(5, [CENTRE.lon + d, CENTRE.lat - 0.06], [CENTRE.lon + d, CENTRE.lat + 0.06], 40));
    }
    const tile = decodeOne(ways);

    const view = createViewMetrics(COLS, ROWS);
    const plain = createSampleBuffer(COLS, ROWS);
    const denso = createSampleBuffer(COLS, ROWS);

    for (const metersPerCell of [400, 150, 60, 20, 5]) {
      const camera = createCameraState(earth.id, {
        ...CENTRE,
        altitudeKm: altitudeForScale(metersPerCell),
      });
      const projection = buildProjection(earth, camera, view);
      const cap = viewCap(camera.lon, camera.lat, projection.visibleGroundRad());
      const subcellRad = projection.metersPerCell() / SUB_X / (earth.radiusKm * 1000);

      const lines: MultiLineString = { type: 'MultiLineString', coordinates: [] };
      for (const street of [...tile.roads, ...tile.water]) {
        if (!capIsVisible(street.cap, cap)) continue;
        resolveLine(street.ring, cap, subcellRad, () => [] as Position[], (piece) => {
          lines.coordinates.push(piece);
        });
      }
      expect(lines.coordinates.length).toBeGreaterThan(0);

      for (const [buffer, dense] of [
        [plain, false],
        [denso, true],
      ] as const) {
        buffer.clear();
        paintBodySilhouette(buffer, projection);
        createSampleContext(buffer, projection, earth, camera).strokeLine(
          lines,
          LINE_CLASS.ROAD,
          1,
          dense,
        );
      }

      let differing = 0;
      for (let i = 0; i < plain.lineMask.length; i++) {
        if (plain.lineMask[i] !== denso.lineMask[i]) differing++;
      }
      expect(differing, `a ${metersPerCell} m por celda`).toBe(0);
    }
  });
});

/**
 * El corte por clase es la razón de que el tile venga ordenado, y la razón de que abrir el zoom
 * sobre una ciudad no cueste recorrer decenas de miles de vías para descartarlas.
 *
 * En Bogotá el 75 % de las vías son residenciales. Si el umbral fuese un `continue` en vez de un
 * `break`, cada frame por encima de 5 km las visitaría todas para no dibujar ninguna.
 */
describe('el orden por clase es lo que hace barato el umbral', () => {
  it('decodifica las calzadas ordenadas por importancia', () => {
    const tile = decodeOne([
      segment(5, [-74.1, 4.6], [-74.0, 4.6]),
      segment(0, [-74.1, 4.61], [-74.0, 4.61]),
      segment(8, [-74.1, 4.62], [-74.0, 4.62]),
      segment(2, [-74.1, 4.63], [-74.0, 4.63]),
    ]);
    expect(tile.roads.map((s) => s.classIndex)).toEqual([0, 2, 5, 8]);
  });

  it('ordena también el agua, para que su propio corte funcione igual', () => {
    const tile = decodeOne([
      segment(STREAM_CLASS, [-74.1, 4.6], [-74.0, 4.6]),
      segment(WATER_CLASS, [-74.1, 4.61], [-74.0, 4.61]),
      segment(0, [-74.1, 4.62], [-74.0, 4.62]),
    ]);
    expect(tile.roads).toHaveLength(1);
    expect(tile.water.map((s) => s.classIndex)).toEqual([WATER_CLASS, STREAM_CLASS]);
  });

  it('una ciudad de decenas de miles de vías sigue dentro del presupuesto de frame', () => {
    /**
     * Proporciones medidas en Bogotá tras encadenar los tramos de OSM: de ~26 600 polilíneas,
     * las clases 0-2 (autopista, troncal, primaria) son en torno al 8 %; el resto es malla
     * residencial y terciaria.
     *
     * La proporción importa: con un 25 % de arterias — que fue el primer intento — el cuadro sale
     * al 41 % de braille mirando la ciudad entera, y el test castigaba al código por un fixture
     * que no se parece a ninguna ciudad.
     */
    const ways: EncodableWay[] = [];
    for (let i = 0; i < 12_000; i++) {
      const cls = i % 12 === 0 ? i % 3 : 5; // ~8 % arterias, ~92 % residenciales
      const lon = CENTRE.lon - 0.13 + (i % 160) * 0.0016;
      const lat = CENTRE.lat - 0.13 + Math.floor(i / 160) * 0.0035;
      ways.push(segment(cls, [lon, lat], [lon + 0.0015, lat + 0.0008], 6));
    }
    const tile = decodeOne(ways);
    expect(tile.roads.length).toBe(12_000);

    const view = createViewMetrics(COLS, ROWS);
    const grid = new Grid(COLS, ROWS);
    const pipeline = createPipeline(COLS, ROWS);
    const stack = new LayerStack([streetsLayer({ tiles: [tile] })]);

    /** Celdas braille tras un frame: la consecuencia observable de cuánto se dibuja. */
    const brailleAt = (altitudeKm: number): number => {
      const camera = createCameraState(earth.id, { ...CENTRE, altitudeKm });
      pipeline.render({ scene: singleBodyScene(earth), camera, view, grid, stack });
      let braille = 0;
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const glyph = grid.get(x, y).glyph;
          if (glyph >= 0x2800 && glyph <= 0x28ff) braille++;
        }
      }
      return braille;
    };

    /**
     * La aserción es **determinista a propósito**. La primera versión medía milisegundos y pasaba
     * sola pero fallaba dentro de la suite completa: un test de reloj bajo ejecución paralela mide
     * la carga de la máquina, no el código. Un test intermitente es peor que ninguno.
     *
     * Lo que sí es estable es cuánto se dibuja. Mirando la ciudad completa el umbral tiene que
     * dejar fuera la malla residencial, así que el braille se queda en una fracción del cuadro —
     * y eso es exactamente lo que hace barato el frame.
     */
    const cells = COLS * ROWS;
    expect(brailleAt(20) / cells).toBeLessThan(0.2);
    expect(brailleAt(1) / cells).toBeLessThan(0.5);

    // Y una red de seguridad grosera contra una regresión de orden de magnitud, holgada para no
    // depender de la carga de la máquina.
    const started = performance.now();
    for (let i = 0; i < 5; i++) brailleAt(1);
    expect((performance.now() - started) / 5).toBeLessThan(40);
  });
});
