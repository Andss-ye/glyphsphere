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

/**
 * Un `way` de Overpass con geometría.
 *
 * Se aceptan **las dos formas** que puede devolver, y no por gusto: `out geom;` sobre vías
 * normales da `geometry: [{lon, lat}, ...]`, mientras que la consulta ligera de abajo pasa por
 * `convert` y da una geometría GeoJSON. La caché en disco del horneado tiene años de respuestas
 * con la primera forma, así que dejar de entenderla obligaría a volver a descargarlo todo.
 */
export interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lon: number; lat: number }[] | { type: string; coordinates: [number, number][] };
}

/**
 * La consulta.
 *
 * Pide **solo lo que se puede dibujar**: la red transitable y el agua. Veredas, accesos de
 * servicio y senderos triplican el peso y a 4 m por celda son ruido.
 *
 * Y pide **solo la etiqueta que se usa**. `out geom;` devuelve cada vía con todas sus etiquetas —
 * nombre, superficie, carriles, velocidad máxima, iluminación — y las coordenadas como objetos
 * `{lat, lon}`. Medido sobre Madrid, un cuadro de 0.14° eran **19 MB descargados para producir un
 * tile de 160 KB**. Pasando por `convert` para quedarse con la clase y con geometría GeoJSON, el
 * mismo cuadro baja un 59 %.
 *
 * No es solo ancho de banda: Overpass reparte turnos por IP cobrando el trabajo que le pedís, así
 * que una consulta obesa se paga en 504 en la siguiente. Pedir de menos es lo que hace que la
 * segunda ciudad también cargue.
 */
export function overpassQuery(
  bbox: readonly [number, number, number, number],
  timeoutS = 180,
): string {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const box = `${minLat},${minLon},${maxLat},${maxLon}`;
  return (
    `[out:json][timeout:${timeoutS}];(` +
    `way["highway"~"^(${ROAD_CLASSES.join('|')})$"](${box});` +
    `way["waterway"~"^(river|canal|stream)$"](${box});` +
    `way["natural"="water"](${box});` +
    `)->.w;` +
    // Una sola etiqueta, `cls`, con el valor que decide la clase. Las tres son excluyentes en la
    // práctica, así que concatenarlas deja exactamente el valor presente.
    `.w convert way ::id=id(),::geom=geom(),` +
    `cls=t["highway"]+t["waterway"]+t["natural"];` +
    `out geom;`
  );
}

/** Las coordenadas de un way, venga en la forma que venga. */
export function geometryOf(way: OverpassWay): [number, number][] {
  const geometry = way.geometry;
  if (!geometry) return [];
  if (Array.isArray(geometry)) return geometry.map((p) => [p.lon, p.lat]);
  return geometry.coordinates ?? [];
}

/** Índice de clase de un way, o -1 si no se dibuja. */
export function classOf(way: OverpassWay): number {
  const tags = way.tags;
  // `cls` es lo que produce la consulta ligera; el resto es la forma clásica, que sigue viva en
  // la caché en disco del horneado.
  const value = tags?.['cls'] ?? tags?.['highway'];
  if (value !== undefined) {
    const index = (ROAD_CLASSES as readonly string[]).indexOf(value);
    if (index >= 0) return index;
    if (value === 'stream') return STREAM_CLASS;
    if (value === 'river' || value === 'canal' || value === 'water') return WATER_CLASS;
  }
  const waterway = tags?.['waterway'];
  if (waterway === 'stream') return STREAM_CLASS;
  if (waterway !== undefined || tags?.['natural'] === 'water') return WATER_CLASS;
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
  // Las coordenadas se normalizan una vez, acá, para que el resto del encadenado no sepa de qué
  // forma vinieron.
  const byClass = new Map<number, { lon: number; lat: number }[][]>();
  for (const way of ways) {
    if (way.type !== 'way') continue;
    const points = geometryOf(way);
    if (points.length < 2) continue;
    const classIndex = classOf(way);
    if (classIndex < 0) continue;
    const geometry = points.map(([lon, lat]) => ({ lon, lat }));
    const list = byClass.get(classIndex);
    if (list) list.push(geometry);
    else byClass.set(classIndex, [geometry]);
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
    group.forEach((points, index) => {
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
        const candidate = group[next]!;
        const forward = keyOf(candidate[0]!) === tail;
        const rest = forward ? candidate.slice(1) : candidate.slice(0, -1).reverse();
        for (const point of rest) points.push(point);
      }
    };

    for (let i = 0; i < group.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const points = [...group[i]!];
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
 * 25 s porque la consulta ligera se sirve en unos pocos: medido, París entero en 3.7 s. Un
 * espejo que no ha contestado una consulta así en veinticinco segundos no está trabajando, está
 * encolando.
 *
 * Es el presupuesto de **toda** la búsqueda, no de cada espejo: ver `deadline` más abajo. Cuando
 * era por espejo, una zona que ninguno podía servir tardaba entre 60 y 187 segundos en admitirlo.
 */
const DEFAULT_TIMEOUT_MS = 25_000;

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

/**
 * Lo que se aparta un espejo que dijo "ahora no puedo".
 *
 * Un 504 o un 429 no es un espejo roto: es uno ocupado, y son servidores públicos que están
 * ocupados a menudo. Apartarlo cinco minutos por eso deja al usuario sin el mejor espejo por un
 * pico de treinta segundos. El apartado largo se reserva para lo que sí es duradero — que la
 * conexión sea rechazada, que es como se manifiesta el límite por IP.
 */
const BUSY_COOLDOWN_MS = 45_000;

/** Cuándo se puede volver a probar cada espejo. */
const mirrorBenchedUntil = new Map<string, number>();

/**
 * Los espejos por orden de preferencia: primero los utilizables, después los apartados.
 *
 * Los apartados van **por cuánto les queda de castigo, del menor al mayor**, y eso importa más de
 * lo que parece. Cuando todos están apartados hay que intentarlo igual — rendirse garantiza no
 * dibujar nada — y sin ordenarlos se prueba primero el que agotó su plazo de veinticinco segundos
 * sin contestar en vez del que solo devolvió un 504 al instante. Medido, eso convertía una
 * consulta de tres segundos en una espera de un minuto.
 *
 * Los sanos conservan el orden de la lista. Hubo una versión que rotaba entre ellos para repartir
 * la carga, y **hacía daño**: dos de los tres espejos aceptan la conexión y no contestan, así que
 * rotar a ciegas repartía peticiones a servidores que cuestan veinticinco segundos cada uno. El
 * apartado por salud ya reparte la carga, pero según cómo se están portando de verdad en vez de
 * por turno.
 */
function mirrorsByHealth(mirrors: readonly string[]): string[] {
  const now = Date.now();
  const healthy: string[] = [];
  const benched: string[] = [];
  for (const mirror of mirrors) {
    ((mirrorBenchedUntil.get(mirror) ?? 0) > now ? benched : healthy).push(mirror);
  }
  benched.sort((a, b) => (mirrorBenchedUntil.get(a) ?? 0) - (mirrorBenchedUntil.get(b) ?? 0));
  return [...healthy, ...benched];
}

/** Olvida el estado de los espejos. Para los tests, que no comparten reloj. */
export function resetMirrorHealth(): void {
  mirrorBenchedUntil.clear();
  lastProbeMs = 0;
}

/**
 * Cada cuánto se vuelve a preguntar por el estado de los espejos.
 *
 * El sondeo es barato pero no gratis, y la salud de un servidor público no cambia cada segundo.
 */
const PROBE_INTERVAL_MS = 300_000;

/** Un espejo que no contesta su estado en esto es que no está. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Margen para no rendirse por un turno que está a punto de liberarse.
 *
 * Un espejo con el turno a tres segundos vista lo va a tener antes de que llegue la petición.
 */
const GRACE_MS = 3_000;

let lastProbeMs = 0;

/** `.../api/interpreter` -> `.../api/status`. */
function statusUrlFor(mirror: string): string {
  return mirror.replace(/\/interpreter\/?$/, '/status');
}

/**
 * Segundos hasta que el espejo tenga turno, según lo que él mismo dice.
 *
 * Overpass publica su cola: `2 slots available now.` o `Slot available after: <fecha>, in 42
 * seconds.` — una línea por turno. Se toma el más próximo.
 */
export function slotWaitSeconds(status: string): number {
  if (/slots? available now/i.test(status)) return 0;
  const waits = [...status.matchAll(/in (-?\d+) seconds/gi)].map((m) => Number(m[1]));
  if (waits.length === 0) return 0;
  return Math.max(0, Math.min(...waits));
}

/**
 * Pregunta a cada espejo cómo está, en paralelo, y apunta el resultado.
 *
 * **Es lo que evita pagar el plazo completo por un servidor que no existe.** Dos de los tres
 * espejos públicos aceptan la conexión y no contestan nunca: descubrirlo con la consulta real
 * cuesta veinticinco segundos cada uno, y como se prueban en cadena, una ciudad que se resolvía
 * en cuatro segundos tardaba más de un minuto en fallar. Su endpoint de estado, en cambio, los
 * separa en menos de uno: medido, 0.65 s el que funciona contra el plazo agotado en los otros dos.
 *
 * De paso resuelve lo otro: si el espejo dice que no tiene turno libre hasta dentro de N segundos,
 * se le cree y se le espera, en vez de insistir y llevarse un 429.
 */
async function probeMirrors(mirrors: readonly string[]): Promise<boolean> {
  const now = Date.now();
  if (now - lastProbeMs < PROBE_INTERVAL_MS) return false;
  lastProbeMs = now;

  const usable = await Promise.all(
    mirrors.map(async (mirror) => {
      try {
        const response = await fetch(statusUrlFor(mirror), {
          // El mismo User-Agent que la consulta, y por el mismo motivo: sin él Overpass responde
          // 406. Sin esto el sondeo se envenenaba solo — daba por muertos a los tres espejos y la
          // búsqueda se rendía en medio segundo con todos disponibles.
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
          mirrorBenchedUntil.set(mirror, Date.now() + BUSY_COOLDOWN_MS);
          return false;
        }
        const waitMs = slotWaitSeconds(await response.text()) * 1000;
        if (waitMs > 0) mirrorBenchedUntil.set(mirror, Date.now() + waitMs);
        else mirrorBenchedUntil.delete(mirror);
        return waitMs <= GRACE_MS;
      } catch {
        mirrorBenchedUntil.set(mirror, Date.now() + MIRROR_COOLDOWN_MS);
        return false;
      }
    }),
  );

  return !usable.some(Boolean);
}

/**
 * Medio lado del cuadro que se pide en vivo: 0.035°, o sea 0.07° de lado, unos 8 km.
 *
 * Es **exactamente el sub-cuadro que usa el horneado**, y no por casualidad: es el tamaño que
 * Overpass sirve sin ahogarse, descubierto cuando el cuadro metropolitano entero devolvía 504 y
 * hubo que partirlo en 4x4. Pedir en vivo el cuadro completo era pedir cuatro veces esa área.
 *
 * Chico tiene además una segunda ventaja acá: una consulta que tarda menos llega antes de que el
 * usuario se haya ido a otro lado. Al desplazarse se piden cuadros vecinos y la cobertura se
 * acumula.
 */
const DEFAULT_HALF_SPAN_DEG = 0.035;

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

  /**
   * Un sondeo barato antes de gastar el plazo largo contra un servidor que no está — y si el
   * sondeo dice que **ninguno** tiene turno ahora, se admite al momento.
   *
   * Consultar igual no acelera nada: el servidor va a rechazar o encolar, y el usuario se queda
   * mirando "consultando OSM…" veinticinco segundos para acabar en lo mismo. Diciéndolo ya, la
   * política de reintentos vuelve a probar cuando el turno se haya liberado.
   *
   * Solo vale para lo que el espejo dice de sí mismo. Estar apartado por una petición que falló
   * es otra cosa: ahí no se sabe cómo está *ahora*, y más vale intentarlo que garantizar que no
   * se dibuje nada.
   */
  if (mirrors.length > 1 && (await probeMirrors(mirrors))) {
    return { status: 'unavailable' };
  }

  /**
   * El plazo es **para toda la búsqueda, no para cada espejo**.
   *
   * Por espejo, tres intentos de veinticinco segundos son setenta y cinco de espera antes de
   * poder decir que no hay datos, y quien mira el mapa no distingue eso de que esté colgado. Un
   * presupuesto compartido acota lo que el usuario espera pase lo que pase; que un espejo lento
   * se lleve casi todo es el precio correcto, porque el que responde lo hace en segundos.
   */
  const deadline = options.signal ?? AbortSignal.timeout(timeoutMs);

  // Los que acaban de fallar van al final de la cola; ver mirrorsByHealth.
  for (const mirror of mirrorsByHealth(mirrors)) {
    if (deadline.aborted) break;
    try {
      const response = await fetch(mirror, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT },
        body,
        signal: deadline,
      });
      if (!response.ok) {
        // 429 y 504 son "estoy ocupado", no "estoy roto".
        const busy = response.status === 429 || response.status === 504;
        mirrorBenchedUntil.set(
          mirror,
          Date.now() + (busy ? BUSY_COOLDOWN_MS : MIRROR_COOLDOWN_MS),
        );
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
        // Casi siempre "query timed out" o "out of memory": el servidor no daba abasto.
        mirrorBenchedUntil.set(mirror, Date.now() + BUSY_COOLDOWN_MS);
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
    }
  }

  /**
   * Nadie pudo servirla, así que lo que se creía de los espejos ya no vale.
   *
   * Sin esto, la foto del sondeo se da por buena cinco minutos: la primera zona sondea mientras
   * el servidor está ocupado, falla, y las siguientes deciden sobre esa foto vieja en vez de
   * volver a mirar — de modo que siguen fallando un buen rato después de que el turno se liberó.
   */
  lastProbeMs = 0;
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
  /**
   * Cuántos tiles se guardan como mucho. Al pasarse se sueltan los más lejanos a la cámara.
   *
   * Existe porque pasear por el mundo iría acumulando ciudades en memoria para siempre. No es un
   * problema de dibujo — con dieciséis tiles el cuadro cuesta lo mismo que con uno, porque un
   * tile fuera de vista se rechaza con un producto punto — sino de memoria.
   */
  readonly maxTiles?: number;
}

/** Cuántos cuadros de rejilla se piden alrededor del que está bajo la cámara. */
const MAX_RING = 2;

/**
 * Los cuadros que cubren lo que se ve, del centro hacia afuera.
 *
 * **Un solo cuadro no alcanza, y esa fue una regresión real.** El cuadro se achicó a 0.07° para
 * que Overpass lo sirviera sin ahogarse, y a esa medida cubre el 7 % del ancho de la pantalla a
 * 25 km de altitud y el 17 % a 10 km: el tile llegaba bien y en pantalla no se veía nada, porque
 * era un parche diminuto en mitad de una vista mucho más ancha.
 *
 * Se devuelven ordenados por cercanía al centro, que es el orden en que conviene pedirlos: lo que
 * el usuario está mirando primero.
 */
export function tilesCovering(
  lon: number,
  lat: number,
  visibleWidthDeg: number,
  halfSpanDeg: number = DEFAULT_HALF_SPAN_DEG,
): { id: string; lon: number; lat: number }[] {
  const span = 2 * halfSpanDeg;
  const ring = Math.min(MAX_RING, Math.max(0, Math.round(visibleWidthDeg / span / 2)));
  const centreLon = (Math.floor(lon / span) + 0.5) * span;
  const centreLat = (Math.floor(lat / span) + 0.5) * span;

  const out: { id: string; lon: number; lat: number; d: number }[] = [];
  for (let dy = -ring; dy <= ring; dy++) {
    for (let dx = -ring; dx <= ring; dx++) {
      const tileLon = centreLon + dx * span;
      const tileLat = centreLat + dy * span;
      // Fuera de los polos no hay nada que pedir, y el cuadro dejaría de ser cuadrado.
      if (tileLat > 85 || tileLat < -85) continue;
      out.push({
        ...onlineTileAt(tileLon, tileLat, halfSpanDeg),
        lon: tileLon,
        lat: tileLat,
        d: dx * dx + dy * dy,
      });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.map(({ id, lon: tileLon, lat: tileLat }) => ({ id, lon: tileLon, lat: tileLat }));
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
  request(lon: number, lat: number, altitudeKm: number, visibleWidthDeg?: number): void;
  readonly tiles: readonly StreetTile[];
  readonly status: OnlineStatus;
} {
  const maxAltitudeKm = options.maxAltitudeKm ?? 25;
  const halfSpanDeg = options.halfSpanDeg ?? DEFAULT_HALF_SPAN_DEG;
  /**
   * Nunca por debajo de lo que un anillo completo necesita.
   *
   * Si el recorte pudiera soltar un cuadro que la vista sigue queriendo, se volvería a pedir en
   * cuanto se suelta: un bucle de descargas contra un servicio público, y la peor clase de bucle
   * porque cada vuelta parece trabajo legítimo.
   */
  const maxTiles = Math.max(options.maxTiles ?? 64, (2 * MAX_RING + 1) ** 2);
  const tiles: StreetTile[] = [];
  const failures = new Map<string, { count: number; nextAttemptMs: number }>();
  const loaded = new Set<string>();
  /**
   * Cuántas consultas se permiten a la vez.
   *
   * Dos, porque es lo que el propio Overpass anuncia (`Rate limit: 2` en su endpoint de estado):
   * pedir de a una dejaba media ciudad sin dibujar durante un buen rato, y pasarse de ahí no trae
   * nada antes — solo encola y consume la cuota.
   */
  const maxInFlight = 2;
  const inFlight = new Set<string>();
  let status: OnlineStatus = 'idle';

  /** Suelta los tiles más lejanos cuando sobran, para que pasear no acumule sin fin. */
  const trim = (lon: number, lat: number): void => {
    if (tiles.length <= maxTiles) return;
    const distance = (tile: StreetTile): number => {
      const [minLon, minLat, maxLon, maxLat] = tile.bbox;
      return ((minLon + maxLon) / 2 - lon) ** 2 + ((minLat + maxLat) / 2 - lat) ** 2;
    };
    tiles.sort((a, b) => distance(a) - distance(b));
    for (const dropped of tiles.splice(maxTiles)) loaded.delete(dropped.id);
  };

  return {
    tiles,
    get status() {
      return status;
    },

    request(lon, lat, altitudeKm, visibleWidthDeg = 0) {
      if (inFlight.size >= maxInFlight || altitudeKm > maxAltitudeKm) return;
      if (!isOnline()) {
        status = 'offline';
        return;
      }

      /**
       * Se pide **un** cuadro por vez, pero el que toque de los que cubren la vista, del centro
       * hacia afuera. Uno solo cubría el 7 % del ancho de la pantalla a 25 km, así que el mapa se
       * quedaba en blanco aunque el tile llegara bien; pedirlos todos a la vez, en cambio, encola
       * la cuota de Overpass y no trae ninguno antes.
       */
      const wanted = tilesCovering(lon, lat, visibleWidthDeg, halfSpanDeg);
      const now = Date.now();
      let target: { id: string; lon: number; lat: number } | undefined;
      let pending = 0;
      let exhausted = 0;
      let here = 0;
      let pidiendo = 0;

      for (const candidate of wanted) {
        if (loaded.has(candidate.id)) {
          here++;
          continue;
        }
        // Ya se está pidiendo: ni se repite ni cuenta como pendiente de reintento.
        if (inFlight.has(candidate.id)) {
          pidiendo++;
          continue;
        }
        const failure = failures.get(candidate.id);
        if (failure) {
          if (failure.count >= BACKOFF_MS.length) {
            exhausted++;
            continue;
          }
          if (now < failure.nextAttemptMs) {
            pending++;
            continue;
          }
        }
        target = candidate;
        break;
      }

      if (!target) {
        // Sin nada nuevo que pedir, lo que se informa es por qué: sigue habiendo una consulta en
        // curso, hay datos, se espera un reintento, o se dejó de insistir. Decir "listo" cuando
        // no se pudo traer nada es la peor opción.
        status =
          pidiendo > 0
            ? 'fetching'
            : pending > 0
              ? 'retrying'
              : exhausted > 0 && here === 0
                ? 'unavailable'
                : 'idle';
        return;
      }

      const id = target.id;
      inFlight.add(id);
      status = 'fetching';

      void fetchOnlineStreets(target.lon, target.lat, options)
        .then((result) => {
          // Antes de publicar el estado: si no, quien observe `status` verá que ya no se está
          // consultando mientras la siguiente petición todavía rebota contra el cerrojo.
          inFlight.delete(id);

          if (result.status === 'ok') {
            loaded.add(id);
            failures.delete(id);
            tiles.push(result.tile);
            trim(lon, lat);
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
          inFlight.delete(id);
        });
    },
  };
}
