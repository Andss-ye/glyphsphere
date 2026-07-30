/**
 * Selección y thinning de una FeatureCollection para un frame.
 *
 * Lo comparten hydro y urban porque el problema es el mismo: un dataset de Natural Earth con
 * miles de features de las que casi ninguna está en pantalla, y de las que están, casi ningún
 * punto es distinguible del siguiente a este zoom. La respuesta también es la misma —
 * rechazar por cap antes de que d3 vea una coordenada, y reconstruir los anillos al detalle que
 * la vista puede mostrar (`docs/RENDERING.md`: cero asignaciones dentro del loop de render).
 */
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import {
  capFeatures,
  capIsVisible,
  capRuns,
  resolveRing,
  type Capped,
  type RunIndexedRing,
  type ViewCap,
} from '../loaders/culling.js';

/** Los anillos de una geometría, aplanados, en orden estable. */
function ringsOfGeometry(geometry: Geometry): Position[][] | null {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return null;
}

/**
 * Una geometría de la misma forma cableada a `rings`, que el llamador después rellena en sitio.
 *
 * Se construye una vez, al cargar. Es lo que permite que el thinning escriba dentro de arrays a
 * los que la geometría de salida ya apunta, sin asignar nada por frame.
 */
function geometryOver(geometry: Geometry, rings: Position[][]): Geometry {
  if (geometry.type === 'LineString') return { type: 'LineString', coordinates: rings[0]! };
  if (geometry.type === 'MultiLineString') return { type: 'MultiLineString', coordinates: rings };
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: rings };
  if (geometry.type === 'MultiPolygon') {
    let at = 0;
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((polygon) => polygon.map(() => rings[at++]!)),
    };
  }
  return geometry;
}

export interface ThinnedFeature {
  /** `scalerank` de Natural Earth: 0 es lo más importante, 12 lo más menor. */
  readonly rank: number;
  readonly capped: Capped<Feature<Geometry>>;
  /** Anillos fuente indexados por runs. `null` para tipos sin anillos que adelgazar. */
  readonly rings: readonly RunIndexedRing[] | null;
  /** Arrays de salida, propiedad de esta feature, rellenados cada frame. */
  readonly out: Position[][];
  /** La feature que se le entrega a d3, apuntando a `out`. */
  readonly thinned: Feature<Geometry>;
}

/**
 * Caps e índices de run se construyen desde cada coordenada del dataset, que no es algo para
 * repetir cada vez que un toggle reconstruye el stack de capas. Va cacheado contra la colección
 * misma, así el trabajo sobrevive lo que dure el dato y se recolecta con él.
 */
const prepared = new WeakMap<FeatureCollection<Geometry>, ThinnedFeature[]>();

export function prepareThinned(collection: FeatureCollection<Geometry>): ThinnedFeature[] {
  const cached = prepared.get(collection);
  if (cached) return cached;

  const features = capFeatures(collection.features as Feature<Geometry>[]).map((capped) => {
    const rank = capped.value.properties?.['scalerank'];
    const source = ringsOfGeometry(capped.value.geometry);
    const out = source ? source.map(() => [] as Position[]) : [];

    return {
      rank: typeof rank === 'number' ? rank : 0,
      capped,
      rings: source ? source.map(capRuns) : null,
      out,
      thinned: source
        ? { ...capped.value, geometry: geometryOver(capped.value.geometry, out) }
        : capped.value,
    };
  });

  prepared.set(collection, features);
  return features;
}

/**
 * Features que pasan el umbral de rango y el cap visible, adelgazadas a lo que se ve.
 *
 * `scratch` lo aporta el llamador y se reusa entre frames: la versión con `.filter()` que esto
 * reemplaza construía una FeatureCollection del planeta entero dos veces por frame. Una sola
 * scratch por capa alcanza siempre que cada selección se consuma antes de pedir la siguiente.
 */
export function selectThinned(
  collection: FeatureCollection<Geometry>,
  maxRank: number,
  view: ViewCap,
  subcellRad: number,
  scratch: FeatureCollection<Geometry>,
): FeatureCollection<Geometry> {
  const features = scratch.features;
  features.length = 0;

  for (const { rank, capped, rings, out, thinned } of prepareThinned(collection)) {
    if (rank > maxRank) continue;
    if (!capIsVisible(capped.cap, view)) continue;

    if (rings !== null) {
      for (let i = 0; i < rings.length; i++) resolveRing(rings[i]!, view, subcellRad, out[i]!);
    }
    features.push(thinned);
  }
  return scratch;
}
