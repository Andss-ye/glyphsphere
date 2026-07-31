import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * El proxy de Overpass.
 *
 * Lo que hay que poder afirmar es lo mismo que del origen en línea, y es **negativo**: que no sea
 * la razón de que el mapa deje de funcionar. Cuando ningún espejo contesta, lo dice con un 502 y
 * el cliente cae de vuelta a lo horneado.
 *
 * Y una cosa positiva que es la razón de que exista: que un espejo muerto no impida que conteste
 * otro. En cadena, el rechazado y el colgado se comían el presupuesto antes de llegar al que
 * sirve — que es exactamente el fallo que se veía en el navegador.
 */

const CONSULTA = '[out:json][timeout:25];(way["highway"](7.0,-73.15,7.07,-73.08););out geom;';

/** Un par petición/respuesta de mentira, con lo justo que el proxy toca. */
function intercambio(query: string | null) {
  const headers = new Map<string, string>();
  let body = '';
  return {
    req: { url: query === null ? '/' : `/?data=${encodeURIComponent(query)}` },
    res: {
      statusCode: 0,
      setHeader(nombre: string, valor: string) {
        headers.set(nombre.toLowerCase(), valor);
      },
      end(cuerpo?: string) {
        body = cuerpo ?? '';
      },
    },
    headers,
    get body() {
      return body;
    },
  };
}

/** El módulo recuerda qué espejo vive, así que cada test parte de cero. */
async function cargar() {
  vi.resetModules();
  return (await import('./overpass.js')).default;
}

const UNO = 'https://overpass-api.de/api/interpreter';
const respuestaOk = (elements: unknown[]) => ({
  ok: true,
  text: async () => JSON.stringify({ elements }),
});

describe('el proxy de Overpass', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('no reenvía nada que no sea una consulta nuestra', async () => {
    const handler = await cargar();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    for (const mala of [
      null,
      '[out:csv][timeout:25];node;out;',
      '[out:json][timeout:900];node;out;',
      `[out:json][timeout:25];${'x'.repeat(2100)}`,
      '[out:json][timeout:0];node;out;',
    ]) {
      const x = intercambio(mala);
      await handler(x.req, x.res);
      expect(x.res.statusCode).toBe(400);
    }

    // Es un endpoint público que hace peticiones salientes: nada de lo anterior sale a la red.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('un espejo muerto no impide que conteste otro', async () => {
    /**
     * La razón de ser del archivo. Probados en cadena, el que rechaza la conexión y el que acepta
     * el TLS sin contestar se llevaban el plazo entero y el que sirve no llegaba a responder.
     * Acá se corren a la vez y gana el que conteste.
     */
    const handler = await cargar();
    globalThis.fetch = vi.fn().mockImplementation((url: string) =>
      url.startsWith(UNO)
        ? Promise.reject(new TypeError('ECONNREFUSED'))
        : Promise.resolve(respuestaOk([{ type: 'way', id: 1 }])),
    ) as unknown as typeof fetch;

    const x = intercambio(CONSULTA);
    await handler(x.req, x.res);

    expect(x.res.statusCode).toBe(200);
    expect(JSON.parse(x.body).elements).toHaveLength(1);
    // Y se puede guardar: la misma zona no vuelve a costar diez segundos.
    expect(x.headers.get('cache-control')).toContain('s-maxage');
  });

  it('un 200 con `remark` es un espejo que falló, no una zona sin calles', async () => {
    /**
     * Overpass avisa así de sus propios errores. Reenviarlo tal cual le diría al cliente "aquí no
     * hay calles", que es definitivo: la zona quedaría marcada para siempre por un fallo pasajero.
     */
    const handler = await cargar();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ elements: [], remark: 'runtime error: out of memory' }),
    }) as unknown as typeof fetch;

    const x = intercambio(CONSULTA);
    await handler(x.req, x.res);
    expect(x.res.statusCode).toBe(502);
  });

  it('si no contesta ninguno lo dice, y no lo deja cacheado', async () => {
    const handler = await cargar();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('sin red')) as unknown as typeof fetch;

    const x = intercambio(CONSULTA);
    await handler(x.req, x.res);

    expect(x.res.statusCode).toBe(502);
    expect(x.headers.get('cache-control')).toBe('no-store');
  });

  it('recuerda el espejo que contestó y deja de molestar a los demás', async () => {
    // Es lo que separa el arranque en frío del resto: la primera consulta descubre quién vive.
    const handler = await cargar();
    const fetchSpy = vi.fn().mockImplementation((url: string) =>
      url.startsWith(UNO)
        ? Promise.reject(new TypeError('ECONNREFUSED'))
        : Promise.resolve(respuestaOk([{ type: 'way', id: 1 }])),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const primera = intercambio(CONSULTA);
    await handler(primera.req, primera.res);
    const enFrio = fetchSpy.mock.calls.length;
    expect(enFrio).toBeGreaterThan(1);

    fetchSpy.mockClear();
    const segunda = intercambio(CONSULTA);
    await handler(segunda.req, segunda.res);

    expect(segunda.res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
