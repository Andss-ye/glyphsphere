import {
  encodeStreets,
  decodeStreets,
  type EncodableWay,
  type StreetTile,
  type StreetsMeta,
} from './streets-bin.js';

/**
 * OpenStreetMap -> tile de calles. **La misma ruta de código para hornear y para descargar.**
 *
 * Es deliberado que sea un solo módulo. `packages/data` lo usa en `pnpm data:build` para producir
 * los assets que viajan con la librería, y el origen en línea de abajo lo usa en runtime para una
 * ciudad que nadie horneó. Como los dos terminan en los mismos bytes, una ciudad descargada y una
 * horneada son indistinguibles — misma clasificación, mismo encadenado, misma simplificación, y
 * por tanto el mismo dibujo.
 *
 * Nada de esto toca el DOM ni Node: `fetch` es estándar en los dos.
 */

/**
 * Clases de vía, **en orden de importancia**. El índice es lo que viaja en el binario, y la capa
 * abre el umbral a medida que la cámara baja: a 20 km se ven troncales, a nivel de calle se ve
 * todo.
 */
export const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'living_street',
  'pedestrian',
] as const;

/**
 * Agua, en dos clases, después de las vías.
 *
 * Un río define una ciudad tanto como una avenida, y por eso el agua no está sujeta al umbral
 * vial. Pero "agua" en OSM incluye la quebrada de tres metros: medido sobre Bogotá a 20 km
 * (419 m por celda), el agua emitía 7 234 puntos contra 4 886 de todas las calzadas juntas — más
 * de la mitad del frame en cauces que a esa escala no cubren ni una subcelda. Así que se separa
 * lo que estructura una ciudad de lo que la drena.
 */
export const WATER_CLASS = ROAD_CLASSES.length;
export const STREAM_CLASS = ROAD_CLASSES.length + 1;
export const CLASS_NAMES = [...ROAD_CLASSES, 'water', 'stream'] as const;

/** Un `way` de Overpass con geometría, que es lo único que este módulo consume. */
export interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lon: number; lat: number }[];
}

/**
 * La consulta. Solo lo que se puede dibujar y significa algo a esta escala: la red transitable y
 * el agua. Veredas, accesos de servicio y senderos triplican el peso y a 4 m por celda son ruido.
 */
export function overpassQuery(
  bbox: readonly [number, number, number, number],
  timeoutS = 180,
): string {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const box = `${minLat},${minLon},${maxLat},${maxLon}`;
  return `[out:json][timeout:${timeoutS}];(
    way["highway"~"^(${ROAD_CLASSES.join('|')})$"](${box});
    way["waterway"~"^(river|canal|stream)$"](${box});
    way["natural"="water"](${box});
  );out geom;`;
}

/** Índice de clase de un way, o -1 si no se dibuja. */
export function classOf(way: OverpassWay): number {
  const highway = way.tags?.['highway'];
  if (highway !== undefined) {
    const index = (ROAD_CLASSES as readonly string[]).indexOf(highway);
    if (index >= 0) return index;
  }
  const waterway = way.tags?.['waterway'];
  if (waterway === 'stream') return STREAM_CLASS;
  if (waterway !== undefined || way.tags?.['natural'] === 'water') return WATER_CLASS;
  return -1;
}

/**
 * Une los tramos contiguos de una misma clase en polilíneas largas.
 *
 * OSM corta cada vía en las intersecciones: la mediana de un tramo *primario* en Bogotá son
 * 101 m, así que una avenida que cruza la ciudad llega como cincuenta trozos. Dibujarlos así es
 * correcto pero caro — d3 paga la puesta en marcha de un stream por cada uno, y medido eran
 * 6.8 ms de más en el frame — y además estropea tanto el adelgazado como la simplificación,
 * porque un tramo de 101 m no tiene puntos suficientes para que ninguna de las dos valga la pena.
 *
 * El encadenado es codicioso y solo une extremo con extremo dentro de la misma clase, así que no
 * inventa geometría: los puntos que salen son exactamente los que entraron.
 */
export function chainWays(ways: readonly OverpassWay[]): EncodableWay[] {
  const byClass = new Map<number, OverpassWay[]>();
  for (const way of ways) {
    if (way.type !== 'way' || !way.geometry || way.geometry.length < 2) continue;
    const classIndex = classOf(way);
    if (classIndex < 0) continue;
    const list = byClass.get(classIndex);
    if (list) list.push(way);
    else byClass.set(classIndex, [way]);
  }

  const out: EncodableWay[] = [];
  // Redondeado a ~1 cm para que dos extremos "iguales" lo sean como clave de texto.
  const keyOf = (p: { lon: number; lat: number }): string =>
    `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;

  for (const [classIndex, group] of byClass) {
    const ends = new Map<string, number[]>();
    const push = (key: string, index: number): void => {
      const list = ends.get(key);
      if (list) list.push(index);
      else ends.set(key, [index]);
    };
    group.forEach((way, index) => {
      const points = way.geometry!;
      push(keyOf(points[0]!), index);
      push(keyOf(points[points.length - 1]!), index);
    });

    const used = new Array<boolean>(group.length).fill(false);

    /** Extiende `points` por su último extremo mientras haya un tramo sin usar que lo continúe. */
    const extend = (points: { lon: number; lat: number }[]): void => {
      for (;;) {
        const tail = keyOf(points[points.length - 1]!);
        const next = (ends.get(tail) ?? []).find((i) => !used[i]);
        if (next === undefined) return;

        used[next] = true;
        const candidate = group[next]!.geometry!;
        const forward = keyOf(candidate[0]!) === tail;
        const rest = forward ? candidate.slice(1) : candidate.slice(0, -1).reverse();
        for (const point of rest) points.push(point);
      }
    };

    for (let i = 0; i < group.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const points = [...group[i]!.geometry!];
      extend(points);
      points.reverse();
      extend(points);
      out.push({ classIndex, points: points.map((p) => [p.lon, p.lat] as const) });
    }
  }

  return out;
}

/**
 * Ways de Overpass -> los bytes del tile, exactamente como los hornea `pnpm data:build`.
 *
 * Pasa por el binario en vez de construir el `StreetTile` directo, y no es un rodeo: es lo que
 * hace que descargar y hornear no puedan divergir, y de paso deja los bytes en la mano de quien
 * llama para guardarlos — una ciudad visitada una vez con red queda disponible sin ella.
 */
export function encodeOsmStreets(
  ways: readonly OverpassWay[],
  bbox: readonly [number, number, number, number],
  radiusKm: number,
): { bytes: Uint8Array; wayCount: number; pointCount: number } {
  return encodeStreets(chainWays(ways), bbox, CLASS_NAMES.length, radiusKm);
}

/** El manifiesto que describe lo que produce este módulo. Para el origen en línea, que no tiene. */
export const OSM_META: StreetsMeta = {
  classes: CLASS_NAMES,
  waterClass: WATER_CLASS,
  tiles: [],
};

/**
 * El cuadro de la rejilla en línea que contiene un punto, y su identidad.
 *
 * **Rejilla fija, no un cuadro centrado en la cámara.** Si el cuadro siguiera a la cámara, cada
 * paso del ratón pediría un tile ligeramente distinto y no habría dos peticiones iguales: la
 * caché no acertaría nunca y Overpass recibiría una consulta por frame.
 *
 * Se exporta porque quien llama necesita la *misma* clave para saber si ya pidió esta zona. Que
 * la calcule por su cuenta es exactamente donde las dos se separan.
 */
export function onlineTileAt(
  lon: number,
  lat: number,
  halfSpanDeg: number = DEFAULT_HALF_SPAN_DEG,
): { id: string; bbox: readonly [number, number, number, number] } {
  const span = 2 * halfSpanDeg;
  const centreLon = (Math.floor(lon / span) + 0.5) * span;
  const centreLat = (Math.floor(lat / span) + 0.5) * span;
  return {
    id: `osm-${centreLon.toFixed(3)}-${centreLat.toFixed(3)}`,
    bbox: [
      centreLon - halfSpanDeg,
      centreLat - halfSpanDeg,
      centreLon + halfSpanDeg,
      centreLat + halfSpanDeg,
    ],
  };
}

export interface OnlineStreetsOptions {
  /**
   * Medio lado del cuadro, en grados. Ver `DEFAULT_HALF_SPAN_DEG`.
   *
   * Subirlo mucho es contraproducente: el cuadro metropolitano entero (0.14°) es justo el que
   * hace que Overpass devuelva 504, y por eso el horneado lo parte en 4x4.
   */
  readonly halfSpanDeg?: number;
  /** Espejos de Overpass. Se prueban en orden, empezando por uno distinto cada vez. */
  readonly mirrors?: readonly string[];
  /**
   * Cuánto se espera. Se le pasa **también al servidor** dentro de la consulta: ver
   * `DEFAULT_TIMEOUT_MS`.
   */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Radio del cuerpo, para la cuantización. */
  readonly radiusKm: number;
}

/**
 * Espejos públicos de Overpass, **todos de cobertura mundial**. Los tres sirven CORS con
 * `Access-Control-Allow-Origin: *`, que es lo que los hace usables desde el navegador —
 * verificado, no supuesto.
 *
 * Tres y no dos porque dos no alcanzan: son servidores gratuitos que se saturan de verdad.
 * Midiéndolos en un mismo minuto, el principal rechazaba la conexión al instante (había limitado
 * la IP) y los otros dos devolvían 504. El orden de arranque rota, así que la carga no cae
 * siempre en el mismo.
 *
 * **Que sean mundiales es un requisito, no una coincidencia.** `overpass.osm.ch` parece un espejo
 * más y responde en 0.6 s con HTTP 200 y CORS correcto — pero es la instancia *suiza* y solo
 * carga Suiza, así que a cualquier consulta fuera de ahí contesta 200 con cero elementos. Un
 * espejo regional no falla: miente, y su mentira es indistinguible de "aquí no hay calles".
 */
const DEFAULT_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * Cuánto se espera una consulta, y cuánto se le declara al servidor.
 *
 * **Los dos números tienen que ser el mismo, y ese fue un error real.** La consulta llevaba
 * `[timeout:180]` mientras el cliente abortaba a los 30 s: Overpass seguía trabajando otros 150 s
 * en un resultado que ya nadie iba a recibir. Overpass reparte turnos por IP y cuenta el trabajo
 * pedido, no el entregado, así que abortar temprano no libera nada — **gasta el turno igual**. Con
 * unas pocas consultas así el servidor deja de aceptar conexiones de esa IP, que es exactamente
 * lo que pasó durante esta sesión: `overpass-api.de` empezó a rechazar la conexión al instante
 * mientras otro espejo seguía respondiendo 200.
 *
 * 60 s porque una consulta real llega a tardar 15 s solo en ejecutarse, más la cola.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Por qué espejo se empieza. Rota para no concentrar los reintentos en uno solo. */
let mirrorCursor = 0;

/**
 * Cuánto se aparta un espejo que acaba de fallar.
 *
 * Sin esto, un espejo que rechaza la conexión se reintenta en cada consulta: la consola del
 * navegador se llena de `net::ERR_CONNECTION_REFUSED` y cada intento gasta el turno del usuario
 * antes de llegar al espejo que sí funciona. Y un rechazo de conexión no es un accidente
 * puntual — Overpass limita por IP durante minutos, así que el que dijo que no va a seguir
 * diciendo que no un buen rato.
 */
const MIRROR_COOLDOWN_MS = 300_000;

/** Cuándo se puede volver a probar cada espejo. */
const mirrorBenchedUntil = new Map<string, number>();

/** Los espejos utilizables ahora, los apartados al final por si no queda ninguno. */
function mirrorsByHealth(mirrors: readonly string[]): string[] {
  const now = Date.now();
  const healthy: string[] = [];
  const benched: string[] = [];
  for (let i = 0; i < mirrors.length; i++) {
    const mirror = mirrors[(mirrorCursor + i) % mirrors.length]!;
    ((mirrorBenchedUntil.get(mirror) ?? 0) > now ? benched : healthy).push(mirror);
  }
  // Los apartados siguen al final: si todos lo están, más vale intentarlo que no dibujar nada.
  return [...healthy, ...benched];
}

/** Olvida el estado de los espejos. Para los tests, que no comparten reloj. */
export function resetMirrorHealth(): void {
  mirrorBenchedUntil.clear();
  mirrorCursor = 0;
}

/**
 * Medio lado del cuadro que se pide en vivo: 0.07°, unos 15 km de lado.
 *
 * Es el mismo tamaño que usa el horneado para cada sub-cuadro, y no por casualidad — el cuadro
 * metropolitano entero devuelve 504, que es lo que obligó a partirlo. Acá además conviene que sea
 * chico por otra razón: una consulta que tarda menos llega antes de que el usuario se haya ido.
 * Al desplazarse se piden cuadros vecinos y la cobertura se acumula.
 */
const DEFAULT_HALF_SPAN_DEG = 0.07;

/**
 * Overpass responde 406 a un User-Agent anónimo, y el de Node lo es.
 *
 * En el navegador `User-Agent` es una cabecera prohibida y se ignora en silencio, así que ponerla
 * es inocuo ahí y es la diferencia entre que haya datos y que no en Node — donde corre el CLI de
 * `@glyphsphere/agent`.
 */
const USER_AGENT = 'glyphsphere/0.1 (offline map, live fallback)';

/**
 * ¿Hay red? `navigator.onLine` en el navegador, y en Node se asume que sí.
 *
 * Es una respuesta barata y **pesimista en el sentido correcto**: un `false` es fiable (el sistema
 * sabe que no hay interfaz), un `true` no garantiza nada. Por eso el origen en línea nunca es la
 * fuente de verdad — es un extra sobre lo horneado, y cualquier fallo cae de vuelta ahí.
 */
export function isOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine ?? true;
}

/**
 * El resultado de pedir una zona.
 *
 * `empty` y `unavailable` están separados a propósito, y no es un detalle: un `null` que significa
 * las dos cosas obliga a quien reintenta a tratar el mar abierto como si fuese un servidor caído,
 * y a gastar tres consultas contra un servicio público para volver a descubrir que ahí no hay
 * calles. `empty` es una respuesta **definitiva**; `unavailable` es la única que merece reintento.
 */
export type OnlineStreetsResult =
  | { readonly status: 'ok'; readonly tile: StreetTile; readonly bytes: Uint8Array }
  | { readonly status: 'empty' }
  | { readonly status: 'unavailable' };

/**
 * Descarga una ciudad que nadie horneó.
 *
 * **Esto no reemplaza al modo offline, lo extiende.** La propuesta del proyecto es funcionar sin
 * red, y los tiles horneados siguen siendo el piso garantizado: si no hay red, si Overpass está
 * saturado, o si la respuesta llega rota, esto no lanza nada — devuelve `unavailable` y el mapa
 * sigue dibujando lo que tiene. Lo que agrega es que la cobertura deje de ser una lista de tres
 * ciudades.
 *
 * El `id` sale de la posición redondeada al cuadro, así que la misma zona pedida dos veces es el
 * mismo tile y se puede cachear por clave.
 *
 * Para uso normal preferí `createOnlineStreetSource`: esta función no tiene política de reintento
 * ni límite de consultas en vuelo, y llamarla desde un bucle de render es un error.
 */
export async function fetchOnlineStreets(
  lon: number,
  lat: number,
  options: OnlineStreetsOptions,
): Promise<OnlineStreetsResult> {
  if (!isOnline()) return { status: 'unavailable' };

  const half = options.halfSpanDeg ?? DEFAULT_HALF_SPAN_DEG;
  const { id, bbox } = onlineTileAt(lon, lat, half);

  const mirrors = options.mirrors ?? DEFAULT_MIRRORS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // El servidor recibe el mismo plazo que espera el cliente: colgar antes no libera su turno.
  const body = new URLSearchParams({
    data: overpassQuery(bbox, Math.floor(timeoutMs / 1000)),
  });

  // Rotado para no concentrar la carga, y con los que acaban de fallar al final de la cola.
  for (const mirror of mirrorsByHealth(mirrors)) {
    try {
      const response = await fetch(mirror, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT },
        body,
        signal: options.signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        mirrorBenchedUntil.set(mirror, Date.now() + MIRROR_COOLDOWN_MS);
        continue;
      }

      const payload = (await response.json()) as {
        elements?: OverpassWay[];
        remark?: string;
      };

      /**
       * Overpass avisa de sus propios errores **con HTTP 200**: si la consulta agota su tiempo o
       * se queda sin memoria, contesta 200 con `elements` vacío y un `remark` explicándolo. Sin
       * mirar el `remark`, una consulta que reventó en el servidor es indistinguible de una zona
       * sin calles — y como "sin calles" es definitivo, la zona quedaría marcada para siempre.
       */
      if (payload.remark !== undefined) {
        mirrorBenchedUntil.set(mirror, Date.now() + MIRROR_COOLDOWN_MS);
        continue;
      }

      const { bytes, wayCount } = encodeOsmStreets(
        payload.elements ?? [],
        bbox,
        options.radiusKm,
      );
      // Overpass contestó de verdad. Que no haya calles es una respuesta, no un fallo.
      if (wayCount === 0) return { status: 'empty' };

      mirrorBenchedUntil.delete(mirror);
      return {
        status: 'ok',
        tile: decodeStreets(bytes, OSM_META, { id, name: id, file: '', bbox }),
        bytes,
      };
    } catch {
      // Sin red, tiempo agotado, o conexión rechazada. Se aparta y se prueba el siguiente.
      mirrorBenchedUntil.set(mirror, Date.now() + MIRROR_COOLDOWN_MS);
      continue;
    } finally {
      mirrorCursor++;
    }
  }

  return { status: 'unavailable' };
}

/** En qué anda el origen en línea. Para que la interfaz pueda decir la verdad. */
export type OnlineStatus =
  | 'idle'
  | 'offline'
  | 'fetching'
  /** Se intentó y falló; se reintentará más tarde. */
  | 'retrying'
  /** Se agotaron los intentos para esta zona en esta sesión. */
  | 'unavailable'
  /** Overpass respondió, pero ahí no hay calles. */
  | 'empty';

export interface OnlineStreetSourceOptions extends OnlineStreetsOptions {
  /** Por encima de esta altitud no se pide nada: las calles ni se dibujarían. */
  readonly maxAltitudeKm?: number;
  /** Se llama al llegar un tile. Los bytes vienen para poder guardarlos y no volver a pedirlos. */
  readonly onTile?: (tile: StreetTile, bytes: Uint8Array) => void;
}

/**
 * Cuánto se espera antes de reintentar una zona que falló, por número de fallos.
 *
 * Agotada la lista, esa zona se abandona para el resto de la sesión. Es deliberado: si Overpass
 * rechazó tres veces, insistir no la va a traer y sí puede hacer que nos limiten.
 */
const BACKOFF_MS = [20_000, 90_000, 300_000];

/**
 * El origen en línea, con la política de cortesía que Overpass necesita.
 *
 * **Esto existe porque la versión sin política estaba mal, y de una forma que no se ve en un
 * test.** `fetchOnlineStreets` es una promesa; quien la llama suele hacerlo desde el bucle de
 * render, o sea sesenta veces por segundo. Si un fallo libera la zona para reintentar, el
 * siguiente frame dispara otra consulta — y como el fallo rápido (espejo caído, HTTP 429) tarda
 * milisegundos, eso son decenas de peticiones por segundo contra un servicio público gratuito.
 * En el navegador se ve como una lluvia de peticiones a `interpreter` marcadas *canceled*.
 *
 * Así que la política vive acá, una vez, y no en cada consumidor:
 *
 * - **Una consulta en vuelo como máximo.** Overpass reparte turnos por IP; pedir cuatro cuadros a
 *   la vez no los trae antes, los encola y consume la cuota.
 * - **Espera creciente y rendición.** 20 s, 90 s, 5 min, y después esa zona se da por perdida.
 * - **`request()` es barato y se puede llamar por frame**, que es como se va a usar igual.
 */
export function createOnlineStreetSource(options: OnlineStreetSourceOptions): {
  request(lon: number, lat: number, altitudeKm: number): void;
  readonly tiles: readonly StreetTile[];
  readonly status: OnlineStatus;
} {
  const maxAltitudeKm = options.maxAltitudeKm ?? 25;
  const halfSpanDeg = options.halfSpanDeg ?? DEFAULT_HALF_SPAN_DEG;
  const tiles: StreetTile[] = [];
  const failures = new Map<string, { count: number; nextAttemptMs: number }>();
  const loaded = new Set<string>();
  let inFlight = false;
  let status: OnlineStatus = 'idle';

  return {
    tiles,
    get status() {
      return status;
    },

    request(lon, lat, altitudeKm) {
      if (inFlight || altitudeKm > maxAltitudeKm) return;
      if (!isOnline()) {
        status = 'offline';
        return;
      }

      const { id } = onlineTileAt(lon, lat, halfSpanDeg);
      if (loaded.has(id)) {
        status = 'idle';
        return;
      }

      const failure = failures.get(id);
      if (failure) {
        if (failure.count >= BACKOFF_MS.length) {
          status = 'unavailable';
          return;
        }
        if (Date.now() < failure.nextAttemptMs) {
          status = 'retrying';
          return;
        }
      }

      inFlight = true;
      status = 'fetching';

      void fetchOnlineStreets(lon, lat, options)
        .then((result) => {
          if (result.status === 'ok') {
            loaded.add(id);
            failures.delete(id);
            tiles.push(result.tile);
            status = 'idle';
            options.onTile?.(result.tile, result.bytes);
            return;
          }

          if (result.status === 'empty') {
            // Definitivo: ahí no hay calles y no las va a haber. Se marca como resuelto para no
            // volver a preguntar — sin esto, el mar abierto cuesta una consulta cada 20 s.
            loaded.add(id);
            status = 'empty';
            return;
          }

          const count = (failures.get(id)?.count ?? 0) + 1;
          failures.set(id, {
            count,
            nextAttemptMs: Date.now() + (BACKOFF_MS[count - 1] ?? 0),
          });
          status = count >= BACKOFF_MS.length ? 'unavailable' : 'retrying';
        })
        .finally(() => {
          inFlight = false;
        });
    },
  };
}
