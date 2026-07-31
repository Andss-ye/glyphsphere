/**
 * Lo poco que este archivo usa de la petición y la respuesta.
 *
 * Se describe acá en vez de importar `node:http` **a propósito**: `@types/node` no está en la raíz
 * del workspace, así que un `import type` de ahí compila en tu máquina y revienta en el build de
 * Vercel, que compila esta función por su cuenta. Sin importaciones no hay nada que resolver, y lo
 * que se declara es exactamente lo que se toca. Tanto Vite como Vercel pasan objetos que encajan.
 */
interface Peticion {
  readonly url?: string | undefined;
}
interface Respuesta {
  statusCode: number;
  setHeader(nombre: string, valor: string): unknown;
  end(cuerpo?: string): unknown;
}

/**
 * Proxy de Overpass, del mismo origen que la página.
 *
 * **Por qué existe, medido y no supuesto.** Desde una conexión doméstica normal, dos de los tres
 * espejos públicos son inalcanzables: `overpass-api.de` rechaza la conexión al instante (limita
 * por IP y no distingue a nadie detrás de un NAT) y `overpass.private.coffee` acepta el TLS y no
 * contesta nunca. El tercero, `maps.mail.ru`, responde en unos diez segundos. Como el cliente los
 * prueba en cadena, el rechazo (0.4 s) más el colgado (12 s) se comían el presupuesto antes de
 * llegar al que sí sirve, y el navegador solo enseñaba dos `ERR_CONNECTION_REFUSED` sin código de
 * estado. Ese es exactamente el fallo que se veía.
 *
 * Puesto acá, el navegador hace **una** petición a su propio origen:
 *
 * - **Sin CORS.** Ni preflight, ni cabeceras que negociar, ni espejos que respondan distinto. Es
 *   lo único que hace la ruta determinista desde el navegador.
 * - **Con User-Agent de verdad.** Overpass contesta 406 a quien no se identifica, y el navegador
 *   no deja ponerlo sin disparar un preflight. Acá es una cabecera más.
 * - **Sin gastar el presupuesto del usuario.** La elección de espejo se paga una vez en el
 *   servidor y se recuerda; el cliente nunca espera por un servidor muerto.
 * - **Cacheable.** La respuesta va por URL (`?data=`), así que el CDN la guarda: volver a la misma
 *   zona, o recargar la página, no vuelve a pagar los diez segundos.
 *
 * **Esto no cambia que la red sea un extra.** Si el proxy no está, falla o tarda, el cliente lo
 * trata como cualquier espejo caído: devuelve `unavailable` y el mapa sigue dibujando lo horneado.
 * Nada de lo que hay acá puede ser la razón de que el mapa deje de funcionar.
 *
 * Sirve a la vez de función de Vercel (`/api/overpass`) y de middleware del servidor de Vite, por
 * eso está tipado con `node:http` y no con los tipos de ningún host: los dos pasan lo mismo.
 */

/**
 * Espejos, en orden de preferencia. Deliberadamente repetidos aquí y no importados de
 * `@glyphsphere/layers`: esta función se despliega sola y no puede depender de que el workspace
 * esté construido. Son tres URLs.
 */
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
] as const;

/** Overpass responde 406 a un User-Agent anónimo, y el de Node lo es. */
const USER_AGENT = 'glyphsphere/0.1 (character-grid map; https://glyphsphere.vercel.app)';

/**
 * Margen sobre el plazo que la propia consulta declara.
 *
 * El presupuesto no se elige acá: viene en `[timeout:N]`, que es el que el cliente va a esperar de
 * verdad. Fijar un número propio garantiza que uno de los dos esté mal — o el proxy corta una
 * consulta que el cliente todavía espera, o sigue trabajando para un cliente que ya se fue. El
 * margen es para la transferencia, que no está incluida en el plazo de Overpass.
 */
const MARGEN_MS = 2_000;

/**
 * El espejo que contestó la última vez, recordado mientras la instancia siga tibia.
 *
 * Es lo que separa el arranque en frío del resto: la primera consulta corre los tres a la vez y
 * descubre cuál vive; las siguientes van directas a ese. Sin esto, cada petición volvería a
 * pagarle el plazo a los muertos, que es el problema que este archivo viene a resolver.
 */
let vivo: string | null = null;

/** Una consulta a un espejo. Lanza si no sirve, para que `Promise.any` se quede con el que sí. */
async function preguntar(mirror: string, data: string, plazoMs: number): Promise<string> {
  const response = await fetch(`${mirror}?data=${encodeURIComponent(data)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(plazoMs),
  });
  if (!response.ok) throw new Error(`${mirror}: HTTP ${response.status}`);

  const text = await response.text();
  /**
   * Overpass avisa de sus propios errores **con HTTP 200**: `elements` vacío más un `remark`. Sin
   * mirarlo, una consulta que reventó en el servidor se lee como "aquí no hay calles" — y eso es
   * definitivo para el cliente, así que la zona quedaría marcada para siempre por un fallo
   * pasajero. Se trata como fallo del espejo para que otro pueda contestar.
   */
  if ((JSON.parse(text) as { remark?: string }).remark !== undefined) {
    throw new Error(`${mirror}: remark`);
  }
  return text;
}

/** El primero que conteste. Prueba el conocido en solitario antes de molestar a los tres. */
async function consultar(data: string, plazoMs: number): Promise<string> {
  if (vivo) {
    try {
      return await preguntar(vivo, data, plazoMs);
    } catch {
      // Dejó de servir: se vuelve a la carrera para encontrar al que lo reemplaza.
      vivo = null;
    }
  }

  /**
   * En frío se corren los tres a la vez y gana el primero.
   *
   * En cadena, el rechazado (0.4 s) y el colgado (12 s) van antes que el que sirve, y con eso el
   * plazo se acaba sin traer nada: es literalmente el fallo que este archivo arregla. Son tres
   * peticiones en vez de una, pero solo la primera vez — desde ahí manda `vivo`.
   */
  const ganador = await Promise.any(
    MIRRORS.map(async (mirror) => ({ mirror, text: await preguntar(mirror, data, plazoMs) })),
  );
  vivo = ganador.mirror;
  return ganador.text;
}

/**
 * Lo que se acepta reenviar.
 *
 * Es un endpoint público que hace peticiones salientes en nombre de quien lo llame, así que la
 * consulta tiene que parecerse a la nuestra: JSON, con un plazo acotado y de un tamaño razonable.
 * Sin esto, cualquiera podría usar el despliegue para lanzar consultas arbitrarias contra Overpass
 * con nuestra IP, y a quien limitarían es a nosotros.
 *
 * ponytail: validación por forma, no por parseo del lenguaje de Overpass. El techo es que una
 * consulta rara pero bien formada pasa; si alguna vez se abusa, lo siguiente es firmar el bbox
 * en el cliente y verificarlo acá.
 */
const MAX_QUERY_CHARS = 2_000;
const MAX_TIMEOUT_S = 30;

/** El plazo que la consulta declara, en segundos, o `null` si no se acepta reenviarla. */
function plazoDeclarado(data: string): number | null {
  if (data.length > MAX_QUERY_CHARS) return null;
  const cabecera = /^\[out:json\]\[timeout:(\d+)\]/.exec(data);
  if (cabecera === null) return null;
  const segundos = Number(cabecera[1]);
  return segundos > 0 && segundos <= MAX_TIMEOUT_S ? segundos : null;
}

export default async function handler(req: Peticion, res: Respuesta): Promise<void> {
  // `req.url` llega relativo en los dos hosts; la base solo existe para poder parsearlo.
  const data = new URL(req.url ?? '/', 'http://localhost').searchParams.get('data');
  const segundos = data === null ? null : plazoDeclarado(data);

  if (data === null || segundos === null) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('se espera ?data= con una consulta [out:json][timeout:N<=30] de hasta 2000 caracteres');
    return;
  }

  try {
    const text = await consultar(data, segundos * 1000 + MARGEN_MS);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    /**
     * La misma zona pedida dos veces sale del CDN, no de Overpass. El cuadro viene de una rejilla
     * fija, así que dos usuarios mirando la misma ciudad piden exactamente la misma URL — que es
     * lo que hace que esto valga la pena y, de paso, lo que nos mantiene dentro de la cuota de un
     * servicio gratuito.
     */
    res.setHeader(
      'Cache-Control',
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    );
    res.end(text);
  } catch (error) {
    // Ningún espejo pudo. Se dice y ya: el cliente lo trata como "no disponible" y el mapa sigue.
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(`ningún espejo de Overpass contestó: ${error instanceof Error ? error.message : ''}`);
  }
}
