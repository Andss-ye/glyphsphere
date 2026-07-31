/**
 * Calles reales, por ciudad, desde OpenStreetMap.
 *
 * Esta es la pieza que le faltaba al zoom. La cámara llega a 4 m por celda, pero Natural Earth
 * 10m solo trae troncales y ETOPO1 son 9.8 km por texel: acercarse a una ciudad no mostraba nada
 * que estuviera realmente ahí. OSM sí tiene la calle.
 *
 * **Sigue siendo offline.** La descarga ocurre acá, en build time, igual que Natural Earth y
 * ETOPO1. Los tiles horneados son el piso garantizado del producto; que además exista un origen
 * en línea (`fetchOnlineStreets`) no cambia eso — extiende la cobertura cuando hay red, y cae de
 * vuelta acá cuando no.
 *
 * La clasificación, el encadenado y el formato viven en `@glyphsphere/layers`, no acá: los
 * comparte con el origen en línea, y compartirlos es lo que garantiza que una ciudad descargada y
 * una horneada se dibujen igual.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { earth } from '@glyphsphere/bodies';
import {
  CLASS_NAMES,
  QUANT_M,
  SIMPLIFY_M,
  WATER_CLASS,
  encodeOsmStreets,
  overpassQuery,
  type OverpassWay,
} from '@glyphsphere/layers';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', 'assets', 'earth', 'streets');
const CACHE_DIR = join(here, '..', '.cache', 'streets');

/**
 * Espejos de Overpass, en orden de preferencia. Se rota entre ellos ante un fallo temporal: son
 * servidores públicos y gratuitos, y saturarlos es a la vez descortés e inútil.
 */
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Overpass exige identificarse; un User-Agent anónimo recibe 406. */
const USER_AGENT = 'glyphsphere/0.1 (offline map data build)';

/**
 * Sub-cuadros por eje en los que se parte una ciudad.
 *
 * Un cuadro metropolitano entero (0.28°) devuelve 504: es demasiado trabajo para una sola
 * consulta pública. Partido en 4x4 cada pedazo son ~8 km de lado, que Overpass sirve sin
 * problema — y cada pedazo se cachea por separado, así que un fallo a mitad de camino no tira
 * lo ya descargado.
 */
const SUB_TILES = 4;

/** Overpass encola las peticiones; si la cola está larga, esperar callado no ayuda a nadie. */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Pausa entre consultas satisfechas. Son servidores públicos con un sistema de turnos por IP:
 * encadenarlas sin respiro hace que el siguiente turno tarde *más*, no menos.
 */
const POLITE_GAP_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ciudades horneadas. Agregar una es agregar una línea: la capa las descubre por el manifiesto y
 * elige por bbox, sin saber cuáles son.
 *
 * `halfSpanDeg` es medio lado del cuadro. 0.14° son unos 31 km de lado en el ecuador — un área
 * metropolitana entera.
 */
const CITIES = [
  { id: 'bogota', name: 'Bogotá', lon: -74.07, lat: 4.65, halfSpanDeg: 0.14 },
  { id: 'tokyo', name: 'Tokio', lon: 139.69, lat: 35.69, halfSpanDeg: 0.14 },
  { id: 'new-york', name: 'Nueva York', lon: -74.0, lat: 40.71, halfSpanDeg: 0.14 },
] as const;

/** Un sub-cuadro, cacheado en disco. Reintenta entre espejos con espera creciente. */
async function fetchBox(
  key: string,
  bbox: readonly [number, number, number, number],
): Promise<OverpassWay[]> {
  const cached = join(CACHE_DIR, `${key}.json`);

  if (!existsSync(cached)) {
    const data = overpassQuery(bbox);
    let lastError = '';

    for (let attempt = 0; attempt < MIRRORS.length * 3; attempt++) {
      const mirror = MIRRORS[attempt % MIRRORS.length]!;
      try {
        const response = await fetch(mirror, {
          method: 'POST',
          // Overpass responde 406 a un User-Agent anónimo — el de Node lo es. Identificarse no
          // es cortesía opcional acá, es la diferencia entre que haya datos y que no.
          headers: { 'User-Agent': USER_AGENT },
          body: new URLSearchParams({ data }),
          // Sin esto una petición encolada del otro lado se queda colgada para siempre y el
          // build no falla ni avanza — que es exactamente lo que pasó la primera vez.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          mkdirSync(CACHE_DIR, { recursive: true });
          writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
          await sleep(POLITE_GAP_MS);
          break;
        }

        // 429 y 504 son "estoy ocupado", no "no existe": esperan y se reintentan.
        lastError = `HTTP ${response.status}`;
        if (response.status !== 429 && response.status !== 504) {
          throw new Error(`${key}: Overpass returned ${response.status}`);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      await sleep(2000 * (attempt + 1));
    }

    if (!existsSync(cached)) {
      throw new Error(
        `${key}: Overpass no respondió (${lastError}). Son servidores públicos y a veces están ` +
          'saturados; reintentá más tarde. Lo ya descargado queda en packages/data/.cache/streets.',
      );
    }
  }

  return (JSON.parse(readFileSync(cached, 'utf8')).elements as OverpassWay[]).filter(
    (way) => way.type === 'way' && way.geometry && way.geometry.length >= 2,
  );
}

/**
 * Una ciudad, como la unión de sus sub-cuadros.
 *
 * Overpass devuelve una vía entera si toca el cuadro, así que la misma calle vuelve en dos
 * pedazos vecinos. Se deduplica por id de OSM — sin eso, cada avenida de borde se dibujaría dos
 * veces y pesaría el doble.
 */
async function fetchCity(city: (typeof CITIES)[number]): Promise<OverpassWay[]> {
  const { lon, lat, halfSpanDeg: h } = city;
  const step = (2 * h) / SUB_TILES;
  const byId = new Map<number, OverpassWay>();
  let fetched = 0;

  for (let iy = 0; iy < SUB_TILES; iy++) {
    for (let ix = 0; ix < SUB_TILES; ix++) {
      const key = `${city.id}-${ix}-${iy}`;
      if (!existsSync(join(CACHE_DIR, `${key}.json`))) {
        process.stdout.write(
          `\r  fetching ${city.name} from OpenStreetMap... ${fetched + 1}/${SUB_TILES ** 2}`,
        );
      }
      const ways = await fetchBox(key, [
        lon - h + ix * step,
        lat - h + iy * step,
        lon - h + (ix + 1) * step,
        lat - h + (iy + 1) * step,
      ]);
      for (const way of ways) byId.set(way.id, way);
      fetched++;
    }
  }
  process.stdout.write('\r'.padEnd(60) + '\r');

  return [...byId.values()];
}

export async function buildStreets(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const tiles = [];
  const pendientes: string[] = [];

  for (const city of CITIES) {
    /**
     * Una ciudad entra **completa o no entra**.
     *
     * Overpass es un servicio público y gratuito, y algunos días no da abasto. Un build que se
     * cae entero por eso es un mal build; uno que hornea media ciudad es peor, porque el mapa
     * sale con agujeros y nada lo dice. Así que se omite la ciudad, se avisa fuerte, y lo ya
     * descargado queda en caché: la siguiente ejecución sigue donde quedó.
     */
    let ways: OverpassWay[];
    try {
      ways = await fetchCity(city);
    } catch (error) {
      pendientes.push(city.name);
      console.warn(
        `  ${city.name}: incompleta, se omite (${error instanceof Error ? error.message : error})`,
      );
      continue;
    }

    const { lon, lat, halfSpanDeg: h } = city;
    const bbox = [lon - h, lat - h, lon + h, lat + h] as const;

    const { bytes, wayCount, pointCount } = encodeOsmStreets(ways, bbox, earth.radiusKm);
    const gz = gzipSync(bytes, { level: 9 });
    const file = `${city.id}.bin.gz`;
    writeFileSync(join(OUT_DIR, file), gz);

    tiles.push({
      id: city.id,
      name: city.name,
      file: `streets/${file}`,
      bbox,
      ways: wayCount,
      points: pointCount,
      bytes: gz.length,
      sha256: createHash('sha256').update(gz).digest('hex'),
    });

    const areaKm2 = (2 * h * 111) ** 2 * Math.cos((lat * Math.PI) / 180);
    console.log(
      `  ${file.padEnd(22)} ${(gz.length / 1024).toFixed(1).padStart(8)} KB gz  ` +
        `${String(wayCount).padStart(6)} vías  ${String(pointCount).padStart(7)} pts  ` +
        `${(gz.length / 1024 / areaKm2).toFixed(1)} KB/km²`,
    );
  }

  writeFileSync(
    join(OUT_DIR, '..', 'streets.json'),
    `${JSON.stringify(
      {
        encoding:
          'u32 magic, u16 version, u16 classCount, u32 wayCount, 4x f64 bbox, u32 gridX, u32 gridY; ' +
          'per way: u8 class, varint points, points x (zigzag varint dx, dy) in grid units',
        quantMetres: QUANT_M,
        simplifyMetres: SIMPLIFY_M,
        classes: CLASS_NAMES,
        // La primera clase de agua. Todo índice desde acá es agua, y dentro del agua el orden
        // sigue siendo de importancia — así que agregar una clase no obliga a tocar la capa.
        waterClass: WATER_CLASS,
        attribution: 'OpenStreetMap contributors, ODbL',
        tiles,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  streets.json           ${tiles.length} ciudades`);

  if (pendientes.length > 0) {
    console.warn(
      `\n  Faltan ${pendientes.length} ciudad(es): ${pendientes.join(', ')}.\n` +
        '  Overpass estaba saturado. Volvé a correr `pnpm data:build`: los sub-cuadros ya\n' +
        '  descargados están en caché, así que retoma donde quedó.',
    );
  }
}
