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
  isOnline,
  overpassQuery,
  resetMirrorHealth,
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
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ elements: [], remark: 'runtime error: out of memory' }),
      })
      .mockResolvedValueOnce(respondeCon([CALLE()]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchOnlineStreets(-74.07, 4.65, {
      radiusKm: earth.radiusKm,
      mirrors: ['https://uno.invalid', 'https://dos.invalid'],
    });
    expect(result.status).toBe('ok');
  });

  it('le declara al servidor el mismo plazo que espera el cliente', async () => {
    /**
     * Pedir `[timeout:180]` y colgar a los 30 s deja a Overpass trabajando 150 s en un resultado
     * que nadie va a recibir. Reparte turnos por IP contando el trabajo *pedido*, así que abortar
     * temprano no libera nada — y con unas pocas consultas así deja de aceptar la conexión.
     */
    const fetchSpy = vi.fn().mockResolvedValue(respondeCon([CALLE()]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await fetchOnlineStreets(-74.07, 4.65, { ...options, timeoutMs: 45_000 });
    const body = fetchSpy.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get('data')).toContain('[timeout:45]');
  });

  it('prueba el siguiente espejo cuando el primero falla', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(respondeCon([CALLE()]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await fetchOnlineStreets(-74.07, 4.65, {
      radiusKm: earth.radiusKm,
      mirrors: ['https://uno.invalid', 'https://dos.invalid'],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.status === 'ok' && result.tile.roads).toHaveLength(1);
  });

  it('aparta el espejo que acaba de fallar en vez de volver a él', async () => {
    /**
     * Sin esto, un espejo que rechaza la conexión se reintenta en cada consulta: la consola del
     * navegador se llena de `net::ERR_CONNECTION_REFUSED` y cada intento gasta tiempo del usuario
     * antes de llegar al que sí funciona. Y un rechazo no es puntual — Overpass limita por IP
     * durante minutos.
     */
    const caido = 'https://caido.invalid';
    const bueno = 'https://bueno.invalid';
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === caido) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(respondeCon([CALLE()]));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const mirrors = [caido, bueno];
    for (let i = 0; i < 4; i++) {
      const result = await fetchOnlineStreets(-74.07, 4.65, { radiusKm: earth.radiusKm, mirrors });
      expect(result.status).toBe('ok');
    }

    // El caído se prueba una vez y queda apartado; las tres consultas siguientes no lo tocan.
    expect(fetchSpy.mock.calls.filter(([url]) => url === caido)).toHaveLength(1);
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

  it('llamar sesenta veces por frame produce UNA consulta', async () => {
    let resolver: ((value: unknown) => void) | undefined;
    const fetchSpy = vi.fn().mockReturnValue(new Promise((r) => (resolver = r)));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const source = createOnlineStreetSource(nunca);
    for (let i = 0; i < 60; i++) source.request(-3.7038, 40.4168, 1);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(source.status).toBe('fetching');

    resolver!(respondeCon([CALLE()]));
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
