import type { Body, Layer } from '@glyphsphere/core';
import { oceanLayer } from './geometry/ocean.js';
import { reliefLayer } from './geometry/relief.js';
import { landmaskLayer } from './geometry/landmask.js';
import { hydroLayer } from './geometry/hydro.js';
import { urbanLayer } from './geometry/urban.js';
import { streetsLayer } from './geometry/streets.js';
import { bordersLayer } from './geometry/borders.js';
import { graticuleLayer } from './geometry/graticule.js';
import { terminatorLayer } from './overlay/terminator.js';
import { placesLayer } from './point/places.js';
import type { LandTopology } from './loaders/topojson.js';
import type { Heightmap } from './loaders/heightmap.js';
import type { Places } from './loaders/places-bin.js';
import type { StreetTile } from './loaders/streets-bin.js';
import type { FeatureCollection, Geometry, MultiLineString } from 'geojson';

export interface DefaultLayerOptions {
  readonly land?: LandTopology;
  readonly heightmap?: Heightmap;
  readonly borders?: MultiLineString;
  readonly rivers?: FeatureCollection<Geometry>;
  readonly lakes?: FeatureCollection<Geometry>;
  readonly places?: Places;
  /** Vías principales. Solo dibujan a escala urbana; ver urbanLayer. */
  readonly roads?: FeatureCollection<Geometry>;
  /** Huella de área construida. */
  readonly urbanAreas?: FeatureCollection<Geometry>;
  /** Tiles de calles reales (OSM). Solo dibujan a escala urbana; ver streetsLayer. */
  readonly streets?: readonly StreetTile[];
  readonly graticule?: boolean;
  /** Fixed instant for the terminator, for deterministic snapshots. */
  readonly now?: () => Date;
}

/**
 * The default stack for a body, in order: ocean, relief, contours, landmask, hydro, urban,
 * borders, graticule, then terminator and places.
 * Contours are not a layer — they are extracted from the elevation field inside the
 * pipeline, between paint and reduce.
 *
 * Layers self-select with `appliesTo`, so a body without a hydrosphere silently gets no ocean
 * and no rivers.
 */
export function defaultLayers(body: Body, options: DefaultLayerOptions = {}): Layer[] {
  const layers: Layer[] = [oceanLayer()];

  // Real elevation replaces the ocean layer's single nominal depth wherever it is available.
  if (options.heightmap) {
    layers.push(reliefLayer({ heightmap: options.heightmap }));
  }
  if (options.land) {
    layers.push(
      landmaskLayer({
        topology: options.land,
        // Only when there is no heightmap: landmask paints after relief, so a nominal height
        // here would flatten every mountain the heightmap just supplied.
        ...(options.heightmap ? {} : { elevationM: 200 }),
      }),
    );
  }
  if (options.rivers || options.lakes) {
    layers.push(
      hydroLayer({
        ...(options.rivers ? { rivers: options.rivers } : {}),
        ...(options.lakes ? { lakes: options.lakes } : {}),
      }),
    );
  }
  // Después de hydro y antes de fronteras: una vía cruza un río y debe verse por encima, pero
  // una frontera es instrumento y gana sobre ambos.
  if (options.roads || options.urbanAreas) {
    layers.push(
      urbanLayer({
        ...(options.roads ? { roads: options.roads } : {}),
        ...(options.urbanAreas ? { urbanAreas: options.urbanAreas } : {}),
      }),
    );
  }
  // Después de urban: las calles reales sustituyen a las troncales generalizadas allí donde
  // existen, y ganan la celda por escribirse más tarde.
  if (options.streets && options.streets.length > 0) {
    layers.push(streetsLayer({ tiles: options.streets }));
  }
  if (options.borders) {
    layers.push(bordersLayer({ mesh: options.borders }));
  }
  if (options.graticule) {
    layers.push(graticuleLayer());
  }

  layers.push(terminatorLayer(options.now ? { at: options.now } : {}));

  // Markers only. The names are not a layer: they are set in real type over the grid by the
  // host, from `cityLabels`. See packages/layers/src/overlay/labels.ts.
  if (options.places) {
    layers.push(placesLayer({ places: options.places, ...(options.now ? { at: options.now } : {}) }));
  }

  return layers.filter((layer) => layer.appliesTo?.(body) ?? true);
}
