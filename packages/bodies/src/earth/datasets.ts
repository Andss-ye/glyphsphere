import type { DatasetManifest } from '@glyphsphere/core';

/**
 * Which asset backs which LOD, per the tables in docs/DATA.md and docs/CAMERA.md.
 * These are asset ids resolved by @glyphsphere/data — the files don't exist yet
 * (`pnpm data:build` generates them), the manifest just declares what layers should ask for.
 */
export const EARTH_DATASETS: DatasetManifest = {
  land: {
    L0: 'land-110m',
    L1: 'land-110m',
    L2: 'land-50m',
    L3: 'land-50m',
    L4: 'land-10m',
  },
  heightmap: 'relief-16bit',
  places: 'places-10m',
  hydro: {
    L3: 'rivers-lakes-10m',
    L4: 'rivers-lakes-10m',
  },
  borders: {
    L0: 'countries-110m',
    L1: 'countries-110m',
    L2: 'countries-50m',
    L3: 'countries-50m',
    L4: 'countries-10m',
  },
  // Escala urbana. Un solo dataset para L4-L7: Natural Earth 10m es la resolución más fina que
  // hay offline, así que no hay una escalera que subir por debajo de eso.
  urban: {
    L4: 'roads-urban-10m',
    L5: 'roads-urban-10m',
    L6: 'roads-urban-10m',
    L7: 'roads-urban-10m',
  },
};
