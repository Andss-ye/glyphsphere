import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * El horneado no puede leer la geometría de Overpass por su cuenta.
 *
 * Esto guarda un fallo que llegó a producción y no dejó rastro: `build-streets.ts` filtraba con
 * `way.geometry.length >= 2`, que solo vale para la forma vieja (`[{lon, lat}, ...]`). Desde que
 * la consulta pasa por `convert`, Overpass devuelve geometría GeoJSON — `{type, coordinates}`,
 * cuyo `.length` es `undefined` — así que el filtro descartaba **todas** las vías. Las tres
 * ciudades se hornearon con cero calles, el manifiesto las anunciaba igual, y el mapa desplegado
 * se quedaba mudo sin una sola petición que mirar.
 *
 * En local no se veía: `.cache/streets` conservaba respuestas de la forma vieja y el build las
 * reusaba. Solo un deploy limpio descargaba con la consulta nueva.
 *
 * `geometryOf` (en `@glyphsphere/layers`) entiende las dos formas, y es el único sitio que debe
 * saber que hay dos. Que lo comparta con el origen en línea es lo que garantiza que una ciudad
 * descargada y una horneada se dibujen igual — mirar `.geometry` a mano rompe justamente eso.
 */
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Se quitan los comentarios: la prosa sí puede nombrar `.geometry` para explicar el fallo. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

describe('la geometría de Overpass se lee por un solo sitio', () => {
  it('ningún script que maneje ways de Overpass toca `.geometry` a mano', () => {
    /**
     * La regla es sobre **ways de Overpass**, no sobre GeoJSON. Un `Feature` de Natural Earth
     * tiene una sola forma de `.geometry` y leerla está bien; lo que tiene dos es lo que devuelve
     * Overpass, y ahí acceder al campo es apostar a una de ellas.
     */
    const ofensores: string[] = [];

    for (const file of sourceFiles(SCRIPTS_DIR)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (!code.includes('OverpassWay')) continue;
      if (/\.geometry\b/.test(code)) ofensores.push(relative(SCRIPTS_DIR, file));
    }

    expect(
      ofensores,
      `usá geometryOf(way) de @glyphsphere/layers en vez de leer .geometry: ${ofensores.join(', ')}`,
    ).toEqual([]);
  });
});
