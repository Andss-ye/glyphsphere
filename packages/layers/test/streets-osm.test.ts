import { afterEach, describe, expect, it, vi } from 'vitest';
import { earth } from '@glyphsphere/bodies';
import {
  CLASS_NAMES,
  OSM_META,
  ROAD_CLASSES,
  STREAM_CLASS,
  WATER_CLASS,
  chainWays,
  createOnlineStreetSource,
  classOf,
  decodeStreets,
  encodeOsmStreets,
  fetchOnlineStreets,
  geometryOf,
  isOnline,
  overpassQuery,
  resetMirrorHealth,
  slotWaitSeconds,
  tilesCovering,
  type OverpassWay,
} from '../src/index.js';

/**
 * OpenStreetMap -> tile, la ruta que comparten el horneado y la descarga.
 *
 * Que la compartan es el contrato que importa: si divergen, una ciudad descargada se dibuja
 * distinto de una horneada y nadie se entera hasta que alguien compara dos capturas.
 */

let id = 0;
function way(tags: Record<string, string>, points: readonly [number, number][]): OverpassWay {
  return {
    type: 'way',
    id: ++id,
    tags,
    geometry: points.map(([lon, lat]) => ({ lon, lat })),
  };
}

const BBOX = [-74.21, 4.51, -73.93, 4.79] as const;

describe('clasificación', () => {
  it('mapea cada clase vial a su índice, en orden de importancia', () => {
    for (const [index, name] of ROAD_CLASSES.entries()) {
      expect(classOf(way({ highway: name }, [[0, 0]]))).toBe(index);
    }
  });

  it('separa el cauce menor del agua mayor', () => {
    expect(classOf(way({ waterway: 'river' }, [[0, 0]]))).toBe(WATER_CLASS);
    expect(classOf(way({ waterway: 'canal' }, [[0, 0]]))).toBe(WATER_CLASS);
    expect(classOf(way({ natural: 'water' }, [[0, 0]]))).toBe(WATER_CLASS);
    expect(classOf(way({ waterway: 'stream' }, [[0, 0]]))).toBe(STREAM_CLASS);
  });

  it('descarta lo que no se dibuja', () => {
    expect(classOf(way({ highway: 'footway' }, [[0, 0]]))).toBe(-1);
    expect(classOf(way({ highway: 'service' }, [[0, 0]]))).toBe(-1);
    expect(classOf(way({}, [[0, 0]]))).toBe(-1);
  });

  it('la consulta pide exactamente las clases que el formato conoce', () => {
    const query = overpassQuery(BBOX);
    for (const name of ROAD_CLASSES) expect(query).toContain(name);
    expect(query).toContain('4.51,-74.21,4.79,-73.93');
    // Lo que no se dibuja tampoco se descarga: triplicaría el peso para nada.
    expect(query).not.toContain('footway');
  });
});

describe('chainWays', () => {
  it('une tramos contiguos de la misma clase en una sola polilínea', () => {
    // OSM parte cada vía en las intersecciones; esto es lo que las vuelve a juntar.
    const chained = chainWays([
      way({ highway: 'primary' }, [[0, 0], [0.001, 0]]),
      way({ highway: 'primary' }, [[0.001, 0], [0.002, 0]]),
      way({ highway: 'primary' }, [[0.002, 0], [0.003, 0]]),
    ]);
    expect(chained).toHaveLength(1);
    expect(chained[0]!.points).toHaveLength(4);
  });

  it('une aunque el tramo venga al revés', () => {
    const chained = chainWays([
      way({ highway: 'primary' }, [[0, 0], [0.001, 0]]),
      way({ highway: 'primary' }, [[0.002, 0], [0.001, 0]]),
    ]);
    expect(chained).toHaveLength(1);
    expect(chained[0]!.points).toHaveLength(3);
  });

  it('no une clases distintas, aunque compartan el extremo', () => {
    // Una primaria que se vuelve residencial en el cruce son dos vías, no una.
    const chained = chainWays([
      way({ highway: 'primary' }, [[0, 0], [0.001, 0]]),
      way({ highway: 'residential' }, [[0.001, 0], [0.002, 0]]),
    ]);
    expect(chained).toHaveLength(2);
  });

  it('no inventa geometría: los puntos que salen son los que entraron', () => {
    // El sentido de la polilínea sí puede darse vuelta — extiende por un extremo, invierte, y
    // extiende por el otro — y a un trazo le da igual. Lo que no puede es mover ni añadir puntos.
    const input: [number, number][] = [[0, 0], [0.001, 0.0005], [0.002, 0]];
    const chained = chainWays([way({ highway: 'trunk' }, input)]);
    const output = chained[0]!.points.map((p) => [...p]);
    expect(output.length).toBe(input.length);
    expect(output[0]![0] === 0 ? output : [...output].reverse()).toEqual(input);
  });

  it('ignora lo que no tiene geometría suficiente', () => {
    expect(chainWays([way({ highway: 'primary' }, [[0, 0]])])).toHaveLength(0);
    expect(chainWays([{ type: 'node', id: 1, tags: { highway: 'primary' } }])).toHaveLength(0);
  });
});

/**
 * La forma en que Overpass devuelve la geometría **hoy**, que no es la de siempre.
 *
 * `out geom;` sobre vías normales da `geometry: [{lon, lat}, ...]`. La consulta actual pasa por
 * `convert`, y entonces da geometría GeoJSON: `{type: 'LineString', coordinates: [[lon, lat], ...]}`.
 *
 * No es un detalle de formato: es el fallo que vació las tres ciudades horneadas en producción.
 * Quien mira `way.geometry.length` en vez de llamar a `geometryOf` lee `undefined` sobre un objeto
 * y descarta **todas** las vías, y el resultado es un tile válido, de 71 bytes, con cero calles.
 * Hasta acá no había un solo test que usara la forma que la consulta produce de verdad.
 */
describe('la geometría que devuelve la consulta con `convert`', () => {
  const geoJsonWay = (cls: string, coordinates: [number, number][]): OverpassWay => ({
    type: 'way',
    id: ++id,
    tags: { cls },
    geometry: { type: 'LineString', coordinates },
  });

  it('lee las coordenadas de las dos formas, y da las mismas', () => {
    const points: [number, number][] = [[-74.07, 4.65], [-74.06, 4.66]];
    expect(geometryOf(geoJsonWay('primary', points))).toEqual(points);
    expect(geometryOf(way({ highway: 'primary' }, points))).toEqual(points);
  });

  it('encadena y hornea la forma GeoJSON en vez de descartarla', () => {
    const chained = chainWays([
      geoJsonWay('primary', [[-74.07, 4.65], [-74.06, 4.66]]),
      geoJsonWay('primary', [[-74.06, 4.66], [-74.05, 4.67]]),
    ]);
    expect(chained).toHaveLength(1);
    expect(chained[0]!.points).toHaveLength(3);

    // Y llega hasta los bytes: un tile con vías, no un encabezado vacío.
    expect(encodeOsmStreets([geoJsonWay('primary', [[-74.07, 4.65], [-74.06, 4.66]])], BBOX,
      earth.radiusKm).wayCount).toBe(1);
  });
});

describe('el origen en línea produce el mismo tile que el horneado', () => {
  const ways = [
    way({ highway: 'primary' }, [[-74.1, 4.6], [-74.09, 4.605], [-74.08, 4.6]]),
    way({ highway: 'residential' }, [[-74.07, 4.64], [-74.06, 4.645]]),
    way({ waterway: 'river' }, [[-74.05, 4.7], [-74.04, 4.71]]),
    way({ waterway: 'stream' }, [[-74.03, 4.72], [-74.02, 4.73]]),
  ];

  it('los mismos ways dan byte por byte el mismo tile', () => {
    const a = encodeOsmStreets(ways, BBOX, earth.radiusKm);
    const b = encodeOsmStreets(ways, BBOX, earth.radiusKm);
    expect([...a.bytes]).toEqual([...b.bytes]);
  });

  it('el manifiesto del origen en línea describe el formato que produce', () => {
    expect(OSM_META.classes).toEqual([...CLASS_NAMES]);
    expect(OSM_META.waterClass).toBe(WATER_CLASS);

    const { bytes } = encodeOsmStreets(ways, BBOX, earth.radiusKm);
    const tile = decodeStreets(bytes, OSM_META, {
      id: 'x',
      name: 'x',
      file: '',
      bbox: BBOX,
    });
    expect(tile.roads.map((s) => s.classIndex)).toEqual([2, 5]);
    expect(tile.water.map((s) => s.classIndex)).toEqual([WATER_CLASS, STREAM_CLASS]);
  });
});

const CALLE = () =>
  way({ highway: 'primary' }, [[-74.07, 4.65], [-74.065, 4.652], [-74.06, 4.65]]);

/** Una respuesta de Overpass con esos elementos. */
const respondeCon = (elements: OverpassWay[]) => ({
  ok: true,
  json: async () => ({ elements }),
});

/**
 * Un `fetch` falso que atiende el endpoint de estado y delega el resto.
 *
 * Con más de un espejo, la búsqueda los sondea antes de consultar — es lo que evita gastar el
 * plazo entero contra un servidor que no está. Un mock que no lo contemple se come esas llamadas
 * y hace fallar al test por algo que en producción funciona.
 */
function fetchFalso(porUrl: (url: string) => unknown) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/status')) {
      return Promise.resolve({ ok: true, text: async () => '2 slots available now.' });
    }
    return Promise.resolve(porUrl(url));
  });
}

/** Espejos de mentira con la forma real, para que `/interpreter` -> `/status` funcione. */
const UNO = 'https://uno.invalid/api/interpreter';
const DOS = 'https://dos.invalid/api/interpreter';

/**
 * La consulta viaja en la URL, no en el cuerpo: se pide con GET para que la respuesta tenga URL
 * propia y la puedan guardar tanto el navegador como un CDN. Así que identificar un espejo es
 * mirar el prefijo, no comparar la URL entera.
 */
const esEspejo = (url: unknown, mirror: string): boolean => String(url).startsWith(`${mirror}?`);

/** Lo que se pidió, leído de la URL. */
const consultaDe = (url: unknown): string =>
  new URL(String(url), 'http://base.invalid').searchParams.get('data') ?? '';

/**
 * Lo que hay que poder afirmar del modo en línea es **negativo**: que nunca sea la razón de que
 * el mapa deje de funcionar. Es un extra sobre lo horneado, así que ningún fallo lanza — todos
 * salen como un estado y dejan al mapa dibujando lo que ya tiene.
 */
describe('el modo en línea nunca es la fuente de verdad', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // La salud de los espejos es estado de módulo: sin esto un test aparta un espejo y el
    // siguiente lo encuentra ya en el banquillo, pasando o fallando por accidente.
    resetMirrorHealth();
  });

  const options = { radiusKm: earth.radiusKm, mirrors: ['https://ejemplo.invalid/api'] };

  it('sin red no intenta nada', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect((await fetchOnlineStreets(-74.07, 4.65, options)).status).toBe('unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('un espejo caído no lanza, informa', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    expect((await fetchOnlineStreets(-74.07, 4.65, options)).status).toBe('unavailable');
  });

  it('una respuesta con error HTTP tampoco lanza', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 504 }) as unknown as typeof fetch;
    expect((await fetchOnlineStreets(-74.07, 4.65, options)).status).toBe('unavailable');
  });

  it('distingue "aquí no hay calles" de "no se pudo preguntar"', async () => {
    /**
     * No es un matiz. Un solo `null` para las dos cosas obliga a reintentar el mar abierto como si
     * fuese un servidor caído: tres consultas contra un servicio público gratuito para volver a
     * descubrir que ahí no hay nada.
     */
    globalThis.fetch = vi.fn().mockResolvedValue(respondeCon([])) as unknown as typeof fetch;
    expect((await fetchOnlineStreets(0, 0, options)).status).toBe('empty');
  });

  it('no confunde un error del servidor con una zona sin calles', async () => {
    /**
     * Overpass avisa de sus propios errores con HTTP 200: `elements` vacío más un `remark`. Sin
     * mirarlo, una consulta que reventó en el servidor se lee como "aquí no hay calles" — y eso
     * es definitivo, así que la zona quedaría marcada para siempre por un fallo pasajero.
     */
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [], remark: 'runtime error: Query timed out' }),
    }) as unknown as typeof fetch;

    expect((await fetchOnlineStreets(-74.07, 4.65, options)).status).toBe('unavailable');
  });

  it('un espejo que revienta no impide que el siguiente conteste', async () => {
    globalThis.fetch = fetchFalso((url) =>
      esEspejo(url, UNO)
        ? { ok: true, json: async () => ({ elements: [], remark: 'runtime error: out of memory' }) }
        : respondeCon([CALLE()]),
    ) as unknown as typeof fetch;

    const result = await fetchOnlineStreets(-74.07, 4.65, {
      radiusKm: earth.radiusKm,
      mirrors: [UNO, DOS],
    });
    expect(result.status).toBe('ok');
  });

  it('le declara al servidor el plazo que ese espejo va a recibir, no el total', async () => {
    /**
     * Pedir `[timeout:180]` y colgar a los 30 s deja a Overpass trabajando 150 s en un resultado
     * que nadie va a recibir. Reparte turnos por IP contando el trabajo *pedido*, así que abortar
     * temprano no libera nada — y con unas pocas consultas así deja de aceptar la conexión.
     *
     * El plazo que cuenta es el **del espejo**, no el de la búsqueda entera: es lo que esa
     * consulta va a esperar de verdad antes de que se corte.
     */
    const fetchSpy = fetchFalso(() => respondeCon([CALLE()]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const consultas = (): string[] =>
      fetchSpy.mock.calls.filter(([u]) => !String(u).endsWith('/status')).map(([u]) => consultaDe(u));

    // Con varios espejos manda el tope por espejo: nadie puede quedarse el presupuesto entero.
    await fetchOnlineStreets(-74.07, 4.65, {
      radiusKm: earth.radiusKm,
      mirrors: [UNO, DOS],
      timeoutMs: 45_000,
    });
    expect(consultas()[0]).toContain('[timeout:12]');

    // Y un presupuesto más corto que el tope manda igual: nunca se pide más de lo que se espera.
    fetchSpy.mockClear();
    await fetchOnlineStreets(-74.2, 4.9, {
      radiusKm: earth.radiusKm,
      mirrors: [UNO, DOS],
      timeoutMs: 5_000,
    });
    expect(consultas()[0]).toContain('[timeout:5]');
  });

  it('con un solo espejo, el presupuesto entero es suyo', async () => {
    /**
     * El tope por espejo existe para que uno colgado no deje sin turno a los demás. Con uno solo
     * no hay a quién proteger, y recortarlo sería regalar presupuesto — que es exactamente el caso
     * del proxy del mismo origen, donde la única espera legítima es la de la consulta.
     */
    const fetchSpy = vi.fn().mockResolvedValue(respondeCon([CALLE()]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await fetchOnlineStreets(-74.07, 4.65, {
      radiusKm: earth.radiusKm,
      mirrors: ['/api/overpass'],
      timeoutMs: 25_000,
    });

    const [url] = fetchSpy.mock.calls[0]!;
    expect(consultaDe(url)).toContain('[timeout:25]');
    // Y con un espejo solo no hay nada que sondear: una petición, la consulta.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(url).startsWith('/api/overpass?')).toBe(true);
  });

  it('prueba el siguiente espejo cuando el primero falla', async () => {
    const fetchSpy = fetchFalso((url) => {
      if (esEspejo(url, UNO)) throw new Error('timeout');
      return respondeCon([CALLE()]);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchOnlineStreets(-74.07, 4.65, {
      radiusKm: earth.radiusKm,
      mirrors: [UNO, DOS],
    });
    expect(result.status === 'ok' && result.tile.roads).toHaveLength(1);
    expect(fetchSpy.mock.calls.filter(([u]) => !String(u).endsWith('/status'))).toHaveLength(2);
  });

  it('aparta el espejo que acaba de fallar en vez de volver a él', async () => {
    /**
     * Sin esto, un espejo que rechaza la conexión se reintenta en cada consulta: la consola del
     * navegador se llena de `net::ERR_CONNECTION_REFUSED` y cada intento gasta tiempo del usuario
     * antes de llegar al que sí funciona. Y un rechazo no es puntual — Overpass limita por IP
     * durante minutos.
     */
    const fetchSpy = fetchFalso((url) => {
      if (esEspejo(url, UNO)) throw new Error('ECONNREFUSED');
      return respondeCon([CALLE()]);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const mirrors = [UNO, DOS];
    for (let i = 0; i < 4; i++) {
      const result = await fetchOnlineStreets(-74.07, 4.65, { radiusKm: earth.radiusKm, mirrors });
      expect(result.status).toBe('ok');
    }

    // El caído se prueba una vez y queda apartado; las tres consultas siguientes no lo tocan.
    expect(fetchSpy.mock.calls.filter(([url]) => esEspejo(url, UNO))).toHaveLength(1);
  });

  it('si todos los espejos están apartados, lo intenta igual', async () => {
    // Rendirse porque todos fallaron hace un rato garantiza no dibujar nada; intentarlo solo
    // cuesta una petición, y la política de reintentos de arriba ya limita cuántas.
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(respondeCon([CALLE()]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const mirrors = ['https://uno.invalid'];
    expect((await fetchOnlineStreets(-74.07, 4.65, { radiusKm: earth.radiusKm, mirrors })).status)
      .toBe('unavailable');
    expect((await fetchOnlineStreets(-74.07, 4.65, { radiusKm: earth.radiusKm, mirrors })).status)
      .toBe('ok');
  });

  it('con todos apartados, prueba primero al que menos castigo le queda', async () => {
    /**
     * El que agota el plazo sin contestar cuesta veinticinco segundos; el que devuelve 504 cuesta
     * milisegundos y vuelve antes. Sin ordenarlos, una consulta de tres segundos se convertía en
     * un minuto de espera porque se probaban primero los colgados.
     */
    // Con la forma real, para que el sondeo se distinga de la consulta: si los dos van a la misma
    // URL no se puede afirmar cuál se pidió primero, que es justo lo que este test mide.
    const colgado = 'https://colgado.invalid/api/interpreter';
    const ocupado = 'https://ocupado.invalid/api/interpreter';
    // Ninguno contesta su estado — es como se porta un espejo colgado de verdad — así que el
    // sondeo no puede decidir el orden y decide lo que costó la consulta anterior.
    const sinEstado = (url: string): unknown | undefined =>
      url.endsWith('/status') ? Promise.reject(new Error('sin respuesta')) : undefined;

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      const estado = sinEstado(url);
      if (estado) return estado;
      if (esEspejo(url, colgado)) return Promise.reject(new Error('TimeoutError'));
      return Promise.resolve({ ok: false, status: 504 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Primera vuelta: los dos fallan. El colgado se aparta 5 min, el ocupado 45 s.
    const mirrors = [colgado, ocupado];
    await fetchOnlineStreets(-74.07, 4.65, { radiusKm: earth.radiusKm, mirrors });

    fetchSpy.mockClear();
    fetchSpy.mockImplementation((url: string) => {
      const estado = sinEstado(url);
      if (estado) return estado;
      return esEspejo(url, colgado)
        ? Promise.reject(new Error('TimeoutError'))
        : Promise.resolve(respondeCon([CALLE()]));
    });

    const result = await fetchOnlineStreets(-74.07, 4.65, { radiusKm: earth.radiusKm, mirrors });
    expect(result.status).toBe('ok');
    // El que menos castigo tenía va primero: se resuelve sin pagar el plazo del colgado.
    const consultas = fetchSpy.mock.calls.filter(([u]) => !String(u).endsWith('/status'));
    expect(esEspejo(consultas[0]![0], ocupado)).toBe(true);
  });

  it('sondea el estado antes de gastar el plazo contra un espejo que no está', async () => {
    /**
     * Dos de los tres espejos públicos aceptan la conexión y no contestan nunca. Descubrirlo con
     * la consulta real cuesta el plazo entero por espejo; su endpoint de estado los separa en
     * menos de un segundo. Medido: una ciudad que se resuelve en 4 s tardaba más de un minuto en
     * fallar sin esto.
     */
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === `${UNO.replace('/interpreter', '/status')}`) throw new Error('sin respuesta');
      if (url.endsWith('/status')) {
        return Promise.resolve({ ok: true, text: async () => '2 slots available now.' });
      }
      return Promise.resolve(respondeCon([CALLE()]));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchOnlineStreets(-74.07, 4.65, {
      radiusKm: earth.radiusKm,
      mirrors: [UNO, DOS],
    });
    expect(result.status).toBe('ok');
    // El que no contestó su estado no llega a recibir la consulta.
    expect(fetchSpy.mock.calls.map(([u]) => u)).not.toContain(UNO);
  });

  it('si ningún espejo tiene turno, lo admite al momento en vez de esperar el plazo', async () => {
    // Consultar igual no acelera nada y deja al usuario esperando para acabar en lo mismo.
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/status')) {
        return Promise.resolve({
          ok: true,
          text: async () => 'Slot available after: X, in 90 seconds.',
        });
      }
      return Promise.resolve(respondeCon([CALLE()]));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchOnlineStreets(-74.07, 4.65, {
      radiusKm: earth.radiusKm,
      mirrors: [UNO, DOS],
    });
    expect(result.status).toBe('unavailable');
    // Ni una consulta: solo los dos sondeos.
    expect(fetchSpy.mock.calls.filter(([u]) => !String(u).endsWith('/status'))).toHaveLength(0);
  });

  it('un sondeo que no llega no impide la consulta', async () => {
    /**
     * **El fallo que dejaba el mapa mudo en producción.** Un sondeo que revienta no dice "el
     * espejo está ocupado", dice "no sé": `/status` puede no servir CORS aunque `/interpreter` sí,
     * el preflight puede caerse, la red puede parpadear. Se contaba como no utilizable, con todos
     * los espejos igual, y la búsqueda devolvía `unavailable` **sin mandar una sola consulta** —
     * ni calles, ni petición en la pestaña de red, ni un código de estado que mirar. Y a los tres
     * fallos la zona quedaba abandonada para toda la sesión, sin haber preguntado nunca.
     */
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/status')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(respondeCon([CALLE()]));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchOnlineStreets(-74.07, 4.65, {
      radiusKm: earth.radiusKm,
      mirrors: [UNO, DOS],
    });

    expect(result.status).toBe('ok');
    expect(fetchSpy.mock.calls.filter(([u]) => !String(u).endsWith('/status')).length)
      .toBeGreaterThan(0);
  });

  it('en Node se identifica, en la consulta y en el sondeo', async () => {
    /**
     * Overpass responde 406 a un User-Agent anónimo, y el de Node lo es. Cuando el sondeo no lo
     * mandaba, se envenenaba solo: daba por muertos a los tres espejos y la búsqueda se rendía en
     * medio segundo teniéndolos todos disponibles. El fallo era invisible porque `curl` sí manda
     * uno, así que comprobarlo a mano decía que todo estaba bien.
     */
    const fetchSpy = fetchFalso(() => respondeCon([CALLE()]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await fetchOnlineStreets(-74.07, 4.65, { radiusKm: earth.radiusKm, mirrors: [UNO, DOS] });

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchSpy.mock.calls) {
      expect((init as RequestInit).headers).toHaveProperty('User-Agent');
    }
  });

  it('en el navegador no manda ninguna cabecera que fuerce un preflight', async () => {
    /**
     * **La otra mitad de por qué no había ni un código de estado que mirar.** `User-Agent` dejó de
     * ser una cabecera prohibida que el navegador ignora: hoy es una cabecera de autor, y como no
     * está en la lista blanca de CORS convierte un POST simple en uno con preflight `OPTIONS`.
     * `maps.mail.ru` contesta `Access-Control-Allow-Headers: Authorization, Content-Type,
     * X-Maps-Platform, X-Maps-Access-Token` — sin `user-agent`, o sea preflight rechazado y la
     * petición cae antes de existir.
     *
     * Sin cabeceras propias, el POST con cuerpo `x-www-form-urlencoded` es una petición simple y
     * sale directa. El navegador manda su propio User-Agent igual, así que el 406 no aplica ahí.
     */
    const process = globalThis.process;
    try {
      // @ts-expect-error se quita a propósito: es como se ve el módulo desde un navegador.
      delete globalThis.process;
      vi.resetModules();
      const modulo = await import('../src/loaders/streets-osm.js');

      const fetchSpy = vi.fn().mockResolvedValue(respondeCon([CALLE()]));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await modulo.fetchOnlineStreets(-74.07, 4.65, options);

      expect(fetchSpy).toHaveBeenCalled();
      for (const [, init] of fetchSpy.mock.calls) {
        expect((init as RequestInit).headers).toEqual({});
      }
    } finally {
      globalThis.process = process;
      vi.resetModules();
    }
  });

  it('respeta el turno que el propio espejo anuncia', () => {
    expect(slotWaitSeconds('2 slots available now.')).toBe(0);
    expect(
      slotWaitSeconds('Slot available after: 2026-07-30T22:30:00Z, in 42 seconds.'),
    ).toBe(42);
    // Con varias líneas manda la más próxima: es cuando habrá un turno libre.
    expect(
      slotWaitSeconds(
        'Slot available after: X, in 90 seconds.\nSlot available after: Y, in 12 seconds.',
      ),
    ).toBe(12);
    // Un formato que no reconoce no puede traducirse en una espera inventada.
    expect(slotWaitSeconds('vaya usted a saber')).toBe(0);
  });

  it('la misma zona pedida dos veces es el mismo tile, para que la caché acierte', async () => {
    // El cuadro sale de una rejilla fija, no de la cámara: si no, cada paso del ratón pide un
    // tile ligeramente corrido y no se acierta nunca.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(respondeCon([CALLE()])) as unknown as typeof fetch;

    const a = await fetchOnlineStreets(-74.07, 4.65, options);
    const b = await fetchOnlineStreets(-74.062, 4.658, options);
    expect(a.status === 'ok' && a.tile.id).toBe(b.status === 'ok' && b.tile.id);
  });

  it('en Node, donde no hay navigator, se asume que sí hay red', () => {
    expect(isOnline()).toBe(true);
    vi.stubGlobal('navigator', { onLine: false });
    expect(isOnline()).toBe(false);
  });
});

/**
 * La cortesía con Overpass, que es lo que estaba mal y de una forma que ningún test de
 * `fetchOnlineStreets` podía ver: la función está bien, **el patrón de llamada estaba mal**.
 *
 * `request()` se llama desde el bucle de render, sesenta veces por segundo. Sin política, un fallo
 * rápido — espejo caído, HTTP 429 — libera la zona y el frame siguiente dispara otra consulta.
 * En el navegador eso es una lluvia de peticiones a `interpreter` marcadas *canceled*, y en
 * Overpass es la IP limitada en minutos.
 */
describe('la política de cortesía del origen en línea', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // La salud de los espejos es estado de módulo: sin esto un test aparta un espejo y el
    // siguiente lo encuentra ya en el banquillo, pasando o fallando por accidente.
    resetMirrorHealth();
  });

  const nunca = { radiusKm: earth.radiusKm, mirrors: ['https://ejemplo.invalid/api'] };

  it('llamar sesenta veces por frame no dispara sesenta consultas', async () => {
    /**
     * Se permiten dos a la vez — es lo que el propio Overpass anuncia como límite por IP — pero
     * ni una más, y desde luego no una por cuadro de render.
     */
    const fetchSpy = vi.fn().mockReturnValue(new Promise(() => {}));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const source = createOnlineStreetSource(nunca);
    for (let i = 0; i < 60; i++) source.request(-3.7038, 40.4168, 1, 0.5);

    expect(fetchSpy.mock.calls.filter(([u]) => !String(u).endsWith('/status'))).toHaveLength(2);
    expect(source.status).toBe('fetching');
  });

  it('un fallo rápido no dispara otra consulta en el frame siguiente', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const source = createOnlineStreetSource(nunca);
    source.request(-3.7038, 40.4168, 1);
    await vi.waitFor(() => expect(source.status).toBe('retrying'));

    // El bucle de render sigue corriendo. Sin espera creciente, esto son 300 consultas.
    for (let i = 0; i < 300; i++) source.request(-3.7038, 40.4168, 1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('se rinde después de tres intentos en vez de insistir para siempre', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const source = createOnlineStreetSource(nunca);

    // Cada vuelta salta la espera avanzando el reloj media hora.
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let attempt = 0; attempt < 6; attempt++) {
      source.request(-3.7038, 40.4168, 1);
      await vi.waitFor(() => expect(['retrying', 'unavailable']).toContain(source.status));
      now += 1_800_000;
    }
    clock.mockRestore();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(source.status).toBe('unavailable');
  });

  it('una zona vacía no se vuelve a preguntar nunca', async () => {
    // El mar abierto es una respuesta definitiva, no un fallo.
    const fetchSpy = vi.fn().mockResolvedValue(respondeCon([]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const source = createOnlineStreetSource(nunca);
    source.request(-40, 30, 1);
    await vi.waitFor(() => expect(source.status).toBe('empty'));

    for (let i = 0; i < 100; i++) source.request(-40, 30, 1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * Una calle dentro del cuadro que se pidió, leyéndolo de la propia consulta.
   *
   * Devolver siempre la misma calle no sirve para probar la cobertura: cae fuera del bbox de los
   * cuadros vecinos, el codificador la recorta, y el resultado es "aquí no hay calles" — que es
   * una respuesta legítima y hace pasar el test por el motivo equivocado.
   */
  function calleEnLaCaja(url: unknown): OverpassWay[] {
    const data = consultaDe(url);
    const m = /\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/.exec(data);
    if (!m) return [];
    const [minLat, minLon, maxLat, maxLon] = m.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const cLon = (minLon + maxLon) / 2;
    const cLat = (minLat + maxLat) / 2;
    const d = (maxLon - minLon) / 8;
    return [
      way({ highway: 'primary' }, [
        [cLon - d, cLat],
        [cLon, cLat + d / 4],
        [cLon + d, cLat],
      ]),
    ];
  }

  it('cubre la vista, no solo el cuadro de debajo de la cámara', async () => {
    /**
     * El cuadro se achicó a 0.07° para que Overpass lo sirviera, y a esa medida cubre el 7 % del
     * ancho de la pantalla a 25 km de altitud. El tile llegaba bien y no se veía nada: un parche
     * diminuto en mitad de una vista mucho más ancha.
     */
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/status')) {
        return Promise.resolve({ ok: true, text: async () => '2 slots available now.' });
      }
      return Promise.resolve(respondeCon(calleEnLaCaja(url)));
    }) as unknown as typeof fetch;

    const source = createOnlineStreetSource(nunca);
    // Una vista de medio grado de ancho: hacen falta varios cuadros de 0.07°.
    for (let i = 0; i < 12; i++) {
      source.request(-74.07, 4.65, 20, 0.5);
      await vi.waitFor(() => expect(source.status).not.toBe('fetching'));
    }

    expect(source.tiles.length).toBeGreaterThan(4);
    // Y todos distintos: cada uno cubre un trozo de la vista.
    expect(new Set(source.tiles.map((t) => t.id)).size).toBe(source.tiles.length);
  });

  it('pide del centro hacia afuera: primero lo que se está mirando', async () => {
    const centro = tilesCovering(-74.07, 4.65, 0.5)[0]!;
    expect(centro.id).toBe(tilesCovering(-74.07, 4.65, 0)[0]!.id);

    // Y a más vista, más cuadros — pero acotados, para no barrer el planeta.
    expect(tilesCovering(-74.07, 4.65, 0).length).toBe(1);
    expect(tilesCovering(-74.07, 4.65, 0.5).length).toBeGreaterThan(4);
    expect(tilesCovering(-74.07, 4.65, 90).length).toBeLessThanOrEqual(25);
  });

  it('no acumula ciudades sin fin al pasear por el mundo', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/status')) {
        return Promise.resolve({ ok: true, text: async () => '2 slots available now.' });
      }
      return Promise.resolve(respondeCon(calleEnLaCaja(url)));
    }) as unknown as typeof fetch;
    const source = createOnlineStreetSource(nunca);

    for (let i = 0; i < 40; i++) {
      source.request(-74.07, 4.65 + i * 0.5, 1);
      await vi.waitFor(() => expect(source.status).not.toBe('fetching'));
    }
    expect(source.tiles.length).toBeLessThanOrEqual(64);
  });

  it('el recorte nunca suelta un cuadro que la vista sigue queriendo', async () => {
    /**
     * Sería un bucle de descargas contra un servicio público, y de la peor clase: cada vuelta
     * parece trabajo legítimo. Por eso el límite nunca baja de lo que cabe en un anillo completo,
     * aunque quien llama pida menos.
     */
    let consultas = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/status')) {
        return Promise.resolve({ ok: true, text: async () => '2 slots available now.' });
      }
      consultas++;
      return Promise.resolve(respondeCon(calleEnLaCaja(url)));
    }) as unknown as typeof fetch;

    const source = createOnlineStreetSource({ ...nunca, maxTiles: 2 });
    // Vista ancha, sin mover la cámara: pide el anillo entero y luego no debería pedir más.
    for (let i = 0; i < 40; i++) {
      source.request(-74.07, 4.65, 20, 0.5);
      await vi.waitFor(() => expect(source.status).not.toBe('fetching'));
    }
    const tras40 = consultas;

    for (let i = 0; i < 20; i++) {
      source.request(-74.07, 4.65, 20, 0.5);
      await vi.waitFor(() => expect(source.status).not.toBe('fetching'));
    }
    expect(consultas).toBe(tras40);
  });

  it('no pide nada por encima de la escala en la que se dibujarían calles', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const source = createOnlineStreetSource({ ...nunca, maxAltitudeKm: 25 });
    source.request(-3.7038, 40.4168, 400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sin red no consulta, y lo dice', () => {
    vi.stubGlobal('navigator', { onLine: false });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const source = createOnlineStreetSource(nunca);
    source.request(-3.7038, 40.4168, 1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(source.status).toBe('offline');
  });

  it('entrega el tile y no lo vuelve a pedir', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(respondeCon([CALLE()])) as unknown as typeof fetch;

    const recibidos: string[] = [];
    const source = createOnlineStreetSource({
      ...nunca,
      onTile: (tile) => recibidos.push(tile.id),
    });

    source.request(-74.07, 4.65, 1);
    await vi.waitFor(() => expect(source.tiles).toHaveLength(1));

    for (let i = 0; i < 50; i++) source.request(-74.07, 4.65, 1);
    expect(recibidos).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
