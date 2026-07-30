/**
 * Escala urbana: vías y huella de área construida.
 *
 * Se descarga en build time y se hornea en `assets/earth/`. En runtime no hay red — esa es la
 * propuesta del proyecto, no un detalle de implementación. El mismo patrón que build-hydro.ts.
 *
 * **Lo que estos datos son y lo que no.** Natural Earth 10m trae la red vial *principal*:
 * autopistas, troncales, y algunas secundarias. No trae calles residenciales ni manzanas. A
 * 200 m de altitud se ve la autopista que cruza la ciudad, no la cuadra. Calle por calle real
 * necesita OSM, que es trabajo futuro (docs/ROADMAP.md) — mientras tanto esto es geometría
 * verdadera, que es la condición que el proyecto no negocia.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', 'assets', 'earth');
const CACHE_DIR = join(here, '..', '.cache');

const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

interface Feature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}

async function fetchGeoJson(name: string): Promise<{ features: Feature[] }> {
  const cached = join(CACHE_DIR, `${name}.geojson`);
  if (!existsSync(cached)) {
    console.log(`  fetching ${name} from Natural Earth...`);
    const response = await fetch(`${BASE}/${name}.geojson`);
    if (!response.ok) throw new Error(`${name}: ${response.status}`);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  }
  return JSON.parse(readFileSync(cached, 'utf8'));
}

/**
 * Cinco decimales son ~1.1 m en el ecuador. La celda más fina que el proyecto puede dibujar es
 * la subcelda braille a 200 m de altitud, que son decenas de metros, así que esto no se ve — y
 * recorta el peso del archivo a la mitad, que sí se nota en un asset que viaja con la app.
 */
function round(coordinates: unknown): unknown {
  if (typeof coordinates === 'number') return Math.round(coordinates * 1e5) / 1e5;
  if (Array.isArray(coordinates)) return coordinates.map(round);
  return coordinates;
}

/**
 * Rango más bajo de `scalerank` que se envía.
 *
 * No es una decisión estética sino de resolución. La cámara encuadra siempre el disco del
 * horizonte completo, así que la celda más fina que llega a dibujar ronda 1.6 km (a la altitud
 * mínima) y ~11 km a 10 km de altura. Una vía de rank 7-10 o un casco urbano de rank 7-9 miden
 * mucho menos que eso: no se pueden resolver a ningún zoom que la cámara alcance.
 *
 * Cortar acá saca el 55 % de los puntos de ambos datasets. Enviarlos costaría ancho de banda
 * offline y milisegundos de frame para dibujar algo que nunca ocupa un píxel.
 */
const MAX_SCALERANK = 6;

/** Se queda solo con las propiedades que alguna capa lee. El resto es metadata de Natural Earth. */
function slim(features: Feature[], keep: readonly string[]): Feature[] {
  const out: Feature[] = [];
  for (const feature of features) {
    if (!feature.geometry) continue;

    const rank = feature.properties['scalerank'];
    if (typeof rank === 'number' && rank > MAX_SCALERANK) continue;

    const properties: Record<string, unknown> = {};
    for (const key of keep) {
      if (feature.properties[key] !== undefined) properties[key] = feature.properties[key];
    }
    out.push({
      type: 'Feature',
      properties,
      geometry: { type: feature.geometry.type, coordinates: round(feature.geometry.coordinates) },
    });
  }
  return out;
}

export async function buildUrban(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const sources = [
    // `type` distingue autopista de troncal; `scalerank` es la jerarquía que la capa filtra.
    { name: 'ne_10m_roads', out: 'roads-10m', keep: ['scalerank', 'type'] },
    { name: 'ne_10m_urban_areas', out: 'urban-areas-10m', keep: ['scalerank'] },
  ] as const;

  for (const { name, out, keep } of sources) {
    const source = await fetchGeoJson(name);
    const collection = {
      type: 'FeatureCollection',
      features: slim(source.features, keep),
    };

    const gz = gzipSync(Buffer.from(JSON.stringify(collection)), { level: 9 });
    const file = `${out}.geojson.gz`;
    writeFileSync(join(OUT_DIR, file), gz);

    writeFileSync(
      join(OUT_DIR, `${out}.json`),
      `${JSON.stringify(
        {
          file,
          features: collection.features.length,
          bytes: gz.length,
          sha256: createHash('sha256').update(gz).digest('hex'),
          attribution: 'Natural Earth (public domain)',
        },
        null,
        2,
      )}\n`,
    );

    console.log(
      `  ${file.padEnd(22)} ${(gz.length / 1024).toFixed(1)} KB gz  ${collection.features.length} features`,
    );
  }
}
