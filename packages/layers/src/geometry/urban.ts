import { LINE_CLASS, SUB_X, type Layer } from '@glyphsphere/core';
import type { FeatureCollection, Geometry } from 'geojson';
import { viewCap } from '../loaders/culling.js';
import { selectThinned } from './thinned.js';

/**
 * Escala urbana: la red vial y la huella de área construida.
 *
 * Los dos se declaran distinto, y la diferencia vuelve a ser el sistema de tres registros
 * haciendo su trabajo:
 *
 * - Una **vía** es una línea. A cualquier zoom en el que se la vea es más delgada que una celda,
 *   así que se declara como linework ROAD y `reduce` la dibuja en braille con precisión de
 *   subcelda.
 * - Un **área construida** es un área, pero su interior *no* se rellena: el relleno lo decide la
 *   banda de elevación, y una ciudad no cambia la altura del terreno. Se declara solo su
 *   contorno, que es la información que realmente aporta — dónde termina la ciudad.
 *
 * Todo esto sale de assets horneados en `pnpm data:build`. En runtime no se toca la red.
 */
export interface UrbanOptions {
  readonly roads?: FeatureCollection<Geometry>;
  readonly urbanAreas?: FeatureCollection<Geometry>;
  /**
   * Por encima de esto la capa no dibuja. 150 km es el piso de L4 en la escalera de LOD: es la
   * altitud a la que una celda pasa a cubrir menos de un par de kilómetros y una autopista deja
   * de ser una raya sobre medio continente.
   */
  readonly maxAltitudeKm?: number;
}

/**
 * `scalerank` en ne_10m_roads es la jerarquía vial: los valores bajos son autopistas y troncales,
 * los altos son vías menores. Abrir el umbral de golpe llena la pantalla de rayas a una altitud
 * en la que todavía no hay lugar para ellas, así que se abre a medida que la cámara baja — el
 * mismo criterio que usa hydro con los ríos.
 */
function maxRoadRank(altitudeKm: number): number {
  if (altitudeKm > 80) return 3;
  if (altitudeKm > 40) return 4;
  if (altitudeKm > 15) return 5;
  return 6; // el dataset ya no trae nada por encima de 6; ver MAX_SCALERANK en build-urban.ts
}

/**
 * La huella construida necesita su **propia** escalera, y omitirla fue caro: `ne_10m_urban_areas`
 * son 11 878 polígonos con 1.15 M de puntos — más puntos que toda la red vial — y sin filtrar
 * costaban 6.7 ms de los 10 ms del frame ellos solos, a 150 km sobre Nueva York.
 *
 * El thinning por subcelda no alcanza acá: `MIN_RING_POINTS` impide adelgazar un anillo por
 * debajo de 32 puntos (para que una isla no quede triángulo), así que un contorno metropolitano
 * que en pantalla mide tres celdas igual aporta 32 proyecciones. El único recorte que sirve es
 * rechazar el polígono entero, y `scalerank` es justamente el orden de importancia por el que
 * hacerlo.
 */
function maxUrbanRank(altitudeKm: number): number {
  if (altitudeKm > 80) return 2;
  if (altitudeKm > 40) return 4;
  return 6;
}

export function urbanLayer(options: UrbanOptions): Layer {
  const maxAltitudeKm = options.maxAltitudeKm ?? 150;

  // Una sola scratch por capa, reusada entre frames. Alcanza porque cada selección se consume
  // antes de pedir la siguiente.
  const scratch: FeatureCollection<Geometry> = { type: 'FeatureCollection', features: [] };

  return {
    id: 'urban',
    kind: 'geometry',

    visibleAt: (camera) => camera.altitudeKm <= maxAltitudeKm,

    paint(ctx) {
      const view = viewCap(ctx.camera.lon, ctx.camera.lat, ctx.projection.visibleGroundRad());
      const subcellRad = ctx.projection.metersPerCell() / SUB_X / (ctx.body.radiusKm * 1000);

      // La huella primero: es contexto, y el orden de capas decide quién gana la celda cuando
      // una vía la cruza (`plot` deja ganar a la clase que se escribe después).
      const { altitudeKm } = ctx.camera;

      if (options.urbanAreas) {
        ctx.strokeLine(
          selectThinned(options.urbanAreas, maxUrbanRank(altitudeKm), view, subcellRad, scratch),
          LINE_CLASS.URBAN,
          1,
        );
      }

      if (options.roads) {
        ctx.strokeLine(
          selectThinned(options.roads, maxRoadRank(altitudeKm), view, subcellRad, scratch),
          LINE_CLASS.ROAD,
          1,
        );
      }
    },
  };
}
