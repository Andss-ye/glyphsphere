import { LINE_CLASS, SUB_X, type Layer } from '@glyphsphere/core';
import type { MultiLineString, Position } from 'geojson';
import { capIsVisible, resolveLine, viewCap } from '../loaders/culling.js';
import type { StreetTile } from '../loaders/streets-bin.js';

/**
 * La calle, dibujada donde realmente está.
 *
 * Es la capa que cierra el zoom: la cámara llega a 4 m por celda, y hasta acá lo único que había
 * a esa escala era Natural Earth 10m — troncales generalizadas a un kilómetro. Una vía de OSM a
 * 20 m por celda es más fina que una celda a cualquier zoom, así que se declara como linework y
 * `reduce` la resuelve en braille con precisión de subcelda: la retícula de una ciudad sale
 * dibujada a 2x4 puntos por carácter, que es exactamente para lo que el registro braille existe.
 *
 * El agua va como RIVER en vez de ROAD. A esta escala la costa de Natural Earth está generalizada
 * a ~1 km — o sea, decenas de celdas de error — así que la hidrografía local de OSM es lo que
 * hace que Manhattan tenga la forma de Manhattan.
 *
 * Todo sale de un asset horneado. En runtime no hay red.
 */
export interface StreetsOptions {
  /** Tiles cargados. La capa elige por bbox; no sabe qué ciudades son. */
  readonly tiles: readonly StreetTile[];
  /** Guarda gruesa por altitud, para cortar la capa antes de que itere nada. */
  readonly maxAltitudeKm?: number;
  /**
   * Escala a la que la capa empieza a dibujar, en metros por celda.
   *
   * Existe para **relevarse limpiamente con los contornos**. El pipeline los calla cuando la celda
   * baja de ~612 m (16 celdas por muestra de ETOPO1); si las calles arrancaran antes, las dos
   * cosas se solapan y se suman: medido sobre Bogotá a 20 km, 60 % de braille de contornos sobre
   * los Andes más 36 % de calles daba un cuadro al 72 %, ilegible y contra la regla de que el
   * braille sea minoría.
   *
   * Así que el relevo es explícito: por encima manda el terreno, por debajo mandan las calles.
   */
  readonly maxMetersPerCell?: number;
}

/**
 * Hasta qué clase se dibuja, en **metros por celda** — no en altitud.
 *
 * Lo que decide si una calle se puede leer no es dónde está la cámara sino cuánto suelo cubre un
 * carácter: una malla residencial de 100 m de paso dibujada a 240 m por celda no produce calles,
 * produce una mancha de braille. Medido sobre Bogotá con el umbral atado a la altitud, el cuadro
 * salía con 50-73 % de celdas braille — `docs/AESTHETIC.md` pide que sea minoría clara — y costaba
 * 15 ms él solo.
 *
 * Los cortes salen del paso típico de cada clase: se admite una clase cuando su separación normal
 * ocupa al menos un par de celdas, que es cuando deja de ser mancha y pasa a ser trama.
 *
 * Como es una razón de escala y no de altitud, se ajusta solo a la rejilla: la misma vista en una
 * terminal más grande muestra más detalle, sin tocar una constante.
 *
 * **Y la clase es el único filtro correcto.** El primer intento descartaba además los tramos más
 * cortos que una celda, y estaba mal: OSM parte cada vía en las intersecciones, así que la mediana
 * de un tramo *primario* en Bogotá son 101 m y el 96 % mide menos de 600 m. Ese filtro no despejaba
 * el mapa, borraba la red — a 20 km desaparecía el 96 % de las avenidas — y el resultado parecía
 * limpio y rápido precisamente porque faltaba casi todo. La longitud de un tramo no dice nada de la
 * importancia de la vía a la que pertenece; `classIndex` sí.
 */
function maxClass(metersPerCell: number): number {
  if (metersPerCell > 300) return 2; // autopista, troncal, primaria: paso de kilómetros
  if (metersPerCell > 100) return 3; // + secundaria: paso de ~1 km
  if (metersPerCell > 45) return 4; // + terciaria: paso de ~400 m
  if (metersPerCell > 18) return 6; // + residencial, sin clasificar: paso de ~100 m
  return 8; // todo, incluidas peatonales
}

/**
 * Escala a la que entran los cauces menores, en metros por celda.
 *
 * El agua no sigue la jerarquía vial — un río es un río a cualquier zoom — pero una quebrada de
 * tres metros no lo es. Medido sobre Bogotá a 20 km, el agua emitía más puntos que todas las
 * calzadas juntas, y eran drenajes que a 419 m por celda no cubren ni una subcelda. El corte va
 * donde va el de las secundarias: es la misma pregunta, cuánto suelo cubre un carácter.
 */
const MINOR_WATER_METERS_PER_CELL = 100;

export function streetsLayer(options: StreetsOptions): Layer {
  const maxAltitudeKm = options.maxAltitudeKm ?? 25;
  const maxMetersPerCell = options.maxMetersPerCell ?? 500;

  // Reusadas cada frame: docs/RENDERING.md prohíbe asignar dentro del loop de render.
  const roads: MultiLineString = { type: 'MultiLineString', coordinates: [] };
  const water: MultiLineString = { type: 'MultiLineString', coordinates: [] };
  const pool: Position[][] = [];
  let used = 0;
  const take = (): Position[] => {
    const ring = pool[used] ?? [];
    pool[used] = ring;
    used++;
    return ring;
  };

  return {
    id: 'streets',
    kind: 'geometry',

    visibleAt: (camera) => camera.altitudeKm <= maxAltitudeKm,

    paint(ctx) {
      const view = viewCap(ctx.camera.lon, ctx.camera.lat, ctx.projection.visibleGroundRad());
      const metersPerCell = ctx.projection.metersPerCell();
      // Por encima de esta escala el relevo lo tiene el terreno; ver maxMetersPerCell.
      if (metersPerCell > maxMetersPerCell) return;

      const subcellRad = metersPerCell / SUB_X / (ctx.body.radiusKm * 1000);
      const limit = maxClass(metersPerCell);
      const minorWater = metersPerCell <= MINOR_WATER_METERS_PER_CELL;

      used = 0;
      roads.coordinates.length = 0;
      water.coordinates.length = 0;

      for (const tile of options.tiles) {
        // Un tile entero fuera de vista se rechaza con un producto punto, antes de mirar una vía.
        if (!capIsVisible(tile.cap, view)) continue;

        // Las calzadas vienen ordenadas por clase, así que el umbral es un corte: en cuanto
        // aparece la primera clase demasiado menor, el resto también lo es.
        for (const street of tile.roads) {
          if (street.classIndex > limit) break;
          if (!capIsVisible(street.cap, view)) continue;

          // Una vía es un trazo: lo que queda fuera de vista se descarta, no se adelgaza.
          resolveLine(street.ring, view, subcellRad, take, (segment) => {
            roads.coordinates.push(segment);
          });
        }

        // El agua va ordenada por clase igual que las calzadas, así que su umbral también corta.
        // La clase mayor (río, canal, lámina) siempre; las siguientes solo con la celda fina.
        const waterLimit = minorWater ? Number.POSITIVE_INFINITY : tile.majorWaterClass;
        for (const stream of tile.water) {
          if (stream.classIndex > waterLimit) break;
          if (!capIsVisible(stream.cap, view)) continue;
          resolveLine(stream.ring, view, subcellRad, take, (segment) => {
            water.coordinates.push(segment);
          });
        }
      }

      // El agua primero: donde una calle cruza un puente, gana la calle — que es lo que se ve
      // desde arriba. `plot` deja ganar a la clase que se escribe después.
      //
      // `dense` porque los vértices de OSM están a ~15 m y la capa no dibuja por encima de 500 m
      // por celda: el vértice más separado sigue estando muy por debajo de una subcelda, así que
      // el resampleo adaptativo de d3 no puede añadir un punto que cambie el cuadro. Medido, es
      // el 30 % del coste de la capa.
      if (water.coordinates.length > 0) ctx.strokeLine(water, LINE_CLASS.RIVER, 1, true);
      if (roads.coordinates.length > 0) ctx.strokeLine(roads, LINE_CLASS.ROAD, 1, true);
    },
  };
}
