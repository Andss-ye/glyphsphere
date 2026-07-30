/**
 * Builds the planetary-scale assets into `assets/earth/`, per docs/DATA.md.
 *
 * Source is `world-atlas`, which is Natural Earth already run through steps 1-4 of the
 * documented pipeline (download, convert, simplify with Visvalingam, quantize and topologize).
 * Reproducing that chain here would need mapshaper plus a shapefile toolchain to arrive at the
 * same bytes, so this build consumes the prebuilt topologies and records their provenance.
 *
 * The heightmap comes from NOAA ETOPO1 — see build-relief.ts. Populated places land with Fase 5.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelief } from './build-relief.js';
import { buildPlaces } from './build-places.js';
import { buildHydro } from './build-hydro.js';
import { buildUrban } from './build-urban.js';
import { buildStreets } from './build-streets.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', 'assets', 'earth');

/**
 * Which Natural Earth resolution backs which LOD. docs/DATA.md and docs/CAMERA.md.
 *
 * docs/DATA.md step 3 also calls for Visvalingam simplification per level. Measured, that is
 * the wrong lever here: at half-a-cell tolerance it removed only 20-36 % of the points while
 * tripling the files, because simplification discards the topology's integer quantization.
 * The cost is not the points that survive clipping, it is streaming every point through the
 * projection to find out — so the fix is a spherical-cap prefilter in the loader instead, which
 * costs nothing in fidelity or bytes. See packages/layers/src/loaders/topojson.ts.
 */
const LAND_SETS = [
  { id: 'land-110m', source: 'world-atlas/land-110m.json', lods: ['L0', 'L1'] },
  { id: 'land-50m', source: 'world-atlas/land-50m.json', lods: ['L2', 'L3'] },
  { id: 'land-10m', source: 'world-atlas/land-10m.json', lods: ['L4'] },
  // Country borders share their edges with each other, which is exactly what topology is for.
  { id: 'countries-110m', source: 'world-atlas/countries-110m.json', lods: ['L0', 'L1'] },
  { id: 'countries-50m', source: 'world-atlas/countries-50m.json', lods: ['L2', 'L3'] },
] as const;

interface ManifestEntry {
  readonly id: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly lods: readonly string[];
}

async function build(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const entries: ManifestEntry[] = LAND_SETS.map(({ id, source, lods }) => {
    const file = `${id}.topo.json`;
    const outPath = join(OUT_DIR, file);
    copyFileSync(require.resolve(source), outPath);

    const bytes = statSync(outPath).size;
    const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex');
    console.log(`  ${file.padEnd(22)} ${(bytes / 1024).toFixed(1).padStart(8)} KB  ${lods.join(',')}`);

    return { id, file, bytes, sha256, lods };
  });

  const manifest = {
    body: 'earth',
    generatedBy: 'packages/data/scripts/build.ts',
    attribution: 'Natural Earth (public domain), via world-atlas',
    datasets: entries,
  };

  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  manifest.json          ${entries.length} datasets`);

  await buildRelief();
  await buildPlaces();
  await buildHydro();
  await buildUrban();
  await buildStreets();
}

await build();
