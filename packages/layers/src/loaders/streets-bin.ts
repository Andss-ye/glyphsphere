import type { Position } from 'geojson';
import { boundingCap, capRuns, type Cap, type RunIndexedRing } from './culling.js';

/**
 * Calles reales por ciudad: el formato binario, de ida y de vuelta.
 *
 * Codificador y decodificador viven en el mismo archivo a propósito — es lo único que garantiza
 * que no se separen. `packages/data` lo usa para hornear; el origen en línea lo usa para producir
 * exactamente el mismo tile, así que una ciudad descargada y una horneada son indistinguibles.
 *
 * El orden de las clases vive en el asset, no acá: el manifiesto lo trae, así que agregar una en
 * el build no obliga a tocar este archivo.
 *
 * ## Formato (versión 2)
 *
 * ```
 *   cabecera  u32 magic | u16 version | u16 classCount | u32 wayCount
 *             4 x f64 bbox | u32 gridX | u32 gridY
 *   por vía   u8 class | varint pointCount | pointCount x (varint dx, varint dy)
 * ```
 *
 * Tres decisiones, todas medidas sobre las tres ciudades horneadas:
 *
 * - **Delta + zigzag varint** en vez de pares u16 absolutos. Un tramo de OSM avanza ~15 m entre
 *   vértices, así que el delta cuantizado entra en un byte donde el absoluto gastaba dos. Con la
 *   cuantización de abajo son el 50 % de lo que pesaba, ya comprimido — gzip no delta-codifica
 *   por su cuenta, así que la ganancia sobrevive al `.gz`.
 * - **La rejilla va en la cabecera** en lugar de ser 0xffff fija. Así la cuantización es ~1 m
 *   *sea cual sea el tamaño del cuadro*, que es lo que deja al origen en línea pedir un área
 *   arbitraria sin inventar un formato nuevo.
 * - **Simplificación al codificar**, con tolerancia de 2 m — una subcelda en el zoom más cerrado
 *   que la cámara alcanza (4 m por celda). Quita el 63 % de los puntos, que es a la vez el 70 %
 *   del peso y, como el coste del frame es proporcional a los puntos emitidos, la mayor parte de
 *   lo que costaba dibujar.
 */

const MAGIC = 0x54535347; // "GSST"
const VERSION = 2;
const HEADER_BYTES = 52;

/**
 * Metros por unidad de cuantización.
 *
 * La subcelda más fina que la cámara dibuja mide 2 m (4 m por celda / 2 subceldas), así que a 1 m
 * la rejilla es el doble de fina que lo más fino que se puede mostrar: la cuantización no es
 * visible a ningún zoom.
 */
export const QUANT_M = 1;

/**
 * Tolerancia de simplificación, en metros.
 *
 * Es la subcelda del zoom más cerrado. Un punto descartado por Douglas-Peucker se aparta de la
 * línea original menos que eso, o sea menos de lo que la pantalla puede distinguir incluso con la
 * cámara en el suelo. Más flojo empieza a redondear esquinas visibles; más estricto deja de pagar.
 */
export const SIMPLIFY_M = 2;

export interface StreetsMeta {
  /** Nombres de clase, en orden de importancia. El índice es lo que viaja en el binario. */
  readonly classes: readonly string[];
  /**
   * Primera clase de agua. Todo índice desde acá es agua y no está sujeto al umbral vial; dentro
   * del agua el orden sigue siendo de importancia, así que la capa puede cortar por escala sin
   * saber cuántas clases de agua hay.
   */
  readonly waterClass: number;
  readonly tiles: readonly StreetTileMeta[];
}

export interface StreetTileMeta {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly bbox: readonly [number, number, number, number];
}

/** Una vía: su clase y su geometría ya indexada por runs, lista para el culling. */
export interface Street {
  readonly classIndex: number;
  readonly ring: RunIndexedRing;
  readonly cap: Cap;
}

export interface StreetTile {
  readonly id: string;
  readonly name: string;
  /** [minLon, minLat, maxLon, maxLat] */
  readonly bbox: readonly [number, number, number, number];
  /** Cap que envuelve el tile entero, para rechazarlo de un tiro. */
  readonly cap: Cap;
  /**
   * Calzadas, **ordenadas por clase ascendente**. Ese orden es lo que deja a la capa cortar el
   * recorrido en cuanto pasa su umbral en vez de recorrer el resto para descartarlo: en Bogotá
   * el 75 % de las vías son residenciales, que no se dibujan hasta el zoom más cerrado.
   */
  readonly roads: readonly Street[];
  /**
   * Agua, aparte y también ordenada por clase: no está sujeta al umbral de jerarquía vial — un río
   * es un río a cualquier zoom — pero una quebrada no lo es, y sí tiene su propio umbral.
   */
  readonly water: readonly Street[];
  /** La clase de agua mayor (río, canal, lámina). Las siguientes son cauces menores. */
  readonly majorWaterClass: number;
}

/** Un punto de vía, en unidades de la rejilla de cuantización. */
export type QuantPoint = readonly [number, number];

/** Una vía lista para codificar. */
export interface EncodableWay {
  readonly classIndex: number;
  readonly points: readonly (readonly [number, number])[];
}

// --- varint -----------------------------------------------------------------------------------

function writeVarint(out: number[], value: number): void {
  let n = value >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

/** Zigzag: mapea los enteros con signo a naturales sin perder los pequeños negativos. */
function writeSignedVarint(out: number[], value: number): void {
  writeVarint(out, ((value << 1) ^ (value >> 31)) >>> 0);
}

// --- simplificación ---------------------------------------------------------------------------

/**
 * Douglas-Peucker sobre coordenadas ya cuantizadas, iterativo.
 *
 * Iterativo y no recursivo porque una vía encadenada de OSM puede traer decenas de miles de
 * puntos y la recursión sobre el peor caso desborda la pila.
 *
 * ponytail: O(n²) en el peor caso — una polilínea donde no se puede descartar nada avanza de a un
 * punto por partición. Solo corre al codificar (`pnpm data:build` y la descarga en línea), nunca
 * por frame, y sobre datos reales converge: las tres ciudades se hornean en segundos. Si alguna
 * vez importa, el arreglo conocido es Douglas-Peucker con casco convexo, O(n log n).
 */
export function simplifyQuantized(
  points: readonly QuantPoint[],
  toleranceUnits: number,
): QuantPoint[] {
  if (points.length < 3 || toleranceUnits <= 0) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: number[] = [0, points.length - 1];
  const tol2 = toleranceUnits * toleranceUnits;

  while (stack.length > 0) {
    const end = stack.pop()!;
    const start = stack.pop()!;
    if (end - start < 2) continue;

    const [ax, ay] = points[start]!;
    const [bx, by] = points[end]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let farthest = -1;
    let farthestD2 = tol2;

    for (let i = start + 1; i < end; i++) {
      const [px, py] = points[i]!;
      let d2: number;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > farthestD2) {
        farthestD2 = d2;
        farthest = i;
      }
    }

    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push(start, farthest, farthest, end);
    }
  }

  const out: QuantPoint[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i] === 1) out.push(points[i]!);
  return out;
}

// --- codificación -----------------------------------------------------------------------------

/** Cuántas unidades de rejilla cubre un cuadro, para que cada una mida `QUANT_M` metros. */
export function gridSizeFor(
  bbox: readonly [number, number, number, number],
  radiusKm: number,
): readonly [number, number] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const metrePerDeg = (Math.PI / 180) * radiusKm * 1000;
  // El paralelo se acorta con la latitud; se toma el más largo del cuadro para no perder
  // resolución en el borde ecuatorial de un cuadro que cruza latitudes.
  const cosLat = Math.max(Math.cos((minLat * Math.PI) / 180), Math.cos((maxLat * Math.PI) / 180));
  return [
    Math.max(1, Math.round(((maxLon - minLon) * metrePerDeg * cosLat) / QUANT_M)),
    Math.max(1, Math.round(((maxLat - minLat) * metrePerDeg) / QUANT_M)),
  ];
}

/**
 * Codifica un tile. `ways` trae grados; la cuantización, el recorte al cuadro y la simplificación
 * ocurren acá, así que el que hornea y el que descarga producen bytes idénticos.
 */
export function encodeStreets(
  ways: readonly EncodableWay[],
  bbox: readonly [number, number, number, number],
  classCount: number,
  radiusKm: number,
): { bytes: Uint8Array; wayCount: number; pointCount: number } {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const spanLon = maxLon - minLon;
  const spanLat = maxLat - minLat;
  const [gridX, gridY] = gridSizeFor(bbox, radiusKm);
  const toleranceUnits = SIMPLIFY_M / QUANT_M;

  const body: number[] = [];
  let wayCount = 0;
  let pointCount = 0;

  for (const { classIndex, points: source } of ways) {
    // Una vía puede salirse del cuadro porque Overpass devuelve la vía entera si la toca. Se
    // recorta para no guardar lo que no se pidió y para que la cuantización no se salga de rango.
    const quantized: QuantPoint[] = [];
    for (const [lon, lat] of source) {
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
      const x = Math.round(((lon - minLon) / spanLon) * gridX);
      const y = Math.round(((lat - minLat) / spanLat) * gridY);
      // Vértices consecutivos que caen en la misma unidad son un punto repetido: cuestan un byte
      // por eje y no mueven nada.
      const previous = quantized[quantized.length - 1];
      if (previous !== undefined && previous[0] === x && previous[1] === y) continue;
      quantized.push([x, y]);
    }

    const points = simplifyQuantized(quantized, toleranceUnits);
    if (points.length < 2) continue;

    body.push(classIndex);
    writeVarint(body, points.length);
    let previousX = 0;
    let previousY = 0;
    for (const [x, y] of points) {
      writeSignedVarint(body, x - previousX);
      writeSignedVarint(body, y - previousY);
      previousX = x;
      previousY = y;
    }

    wayCount++;
    pointCount += points.length;
  }

  const bytes = new Uint8Array(HEADER_BYTES + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, classCount, true);
  view.setUint32(8, wayCount, true);
  view.setFloat64(12, minLon, true);
  view.setFloat64(20, minLat, true);
  view.setFloat64(28, maxLon, true);
  view.setFloat64(36, maxLat, true);
  view.setUint32(44, gridX, true);
  view.setUint32(48, gridY, true);
  bytes.set(body, HEADER_BYTES);

  return { bytes, wayCount, pointCount };
}

// --- decodificación ---------------------------------------------------------------------------

/**
 * Decodifica un tile.
 *
 * Las coordenadas se expanden una vez, al cargar, a la misma forma que consume el culling
 * (`capRuns`), para que la capa no tenga que conocer el formato ni convertir nada por frame.
 */
export function decodeStreets(
  bytes: Uint8Array,
  meta: StreetsMeta,
  tile: StreetTileMeta,
): StreetTile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < HEADER_BYTES || view.getUint32(0, true) !== MAGIC) {
    throw new Error(`${tile.id}: not a glyphsphere streets tile`);
  }
  const version = view.getUint16(4, true);
  if (version !== VERSION) {
    // Un asset viejo decodificado con este lector no da error, da geometría plausible y falsa.
    // Vale mucho más fallar acá y pedir `pnpm data:build`.
    throw new Error(
      `${tile.id}: streets tile is version ${version}, this build reads ${VERSION}. Run \`pnpm data:build\`.`,
    );
  }

  const wayCount = view.getUint32(8, true);
  const minLon = view.getFloat64(12, true);
  const minLat = view.getFloat64(20, true);
  const maxLon = view.getFloat64(28, true);
  const maxLat = view.getFloat64(36, true);
  const gridX = view.getUint32(44, true);
  const gridY = view.getUint32(48, true);
  const scaleLon = (maxLon - minLon) / gridX;
  const scaleLat = (maxLat - minLat) / gridY;

  const roads: Street[] = [];
  const water: Street[] = [];
  let offset = HEADER_BYTES;

  const readVarint = (): number => {
    let result = 0;
    let shift = 1;
    for (;;) {
      const byte = bytes[offset++]!;
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return result;
      shift *= 0x80;
    }
  };
  // Zigzag inverso. Sin `| 0`: un delta grande sigue siendo exacto como número.
  const readSigned = (): number => {
    const n = readVarint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  };

  for (let w = 0; w < wayCount; w++) {
    const classIndex = bytes[offset++]!;
    const pointCount = readVarint();

    const coordinates: Position[] = new Array(pointCount);
    let x = 0;
    let y = 0;
    for (let i = 0; i < pointCount; i++) {
      x += readSigned();
      y += readSigned();
      coordinates[i] = [minLon + x * scaleLon, minLat + y * scaleLat];
    }

    (classIndex >= meta.waterClass ? water : roads).push({
      classIndex,
      ring: capRuns(coordinates),
      cap: boundingCap([coordinates]),
    });
  }

  // Una vez, al cargar. Deja el filtro por escala como un corte, no como un recorrido.
  roads.sort((a, b) => a.classIndex - b.classIndex);
  water.sort((a, b) => a.classIndex - b.classIndex);

  const corners: Position[] = [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
  ];

  return {
    id: tile.id,
    name: tile.name,
    bbox: [minLon, minLat, maxLon, maxLat],
    cap: boundingCap([corners]),
    roads,
    water,
    majorWaterClass: meta.waterClass,
  };
}

/** Descarga y decodifica un tile. El `.gz` se descomprime acá si el servidor no lo hizo. */
export async function loadStreetTile(
  url: string,
  meta: StreetsMeta,
  tile: StreetTileMeta,
): Promise<StreetTile> {
  const response = await fetch(url);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return decodeStreets(bytes, meta, tile);
}

/** El tile cuyo bbox contiene el punto, si hay alguno. */
export function tileAt(
  tiles: readonly StreetTileMeta[],
  lon: number,
  lat: number,
): StreetTileMeta | undefined {
  return tiles.find(
    ({ bbox }) => lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3],
  );
}
