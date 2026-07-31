# @glyphsphere/agent

Contexto geoespacial para modelos de lenguaje, offline y determinista.

Un mapa comercial responde "¿qué hay en estas coordenadas?" con geometría: anillos de lon/lat,
o un PNG. Un modelo no puede razonar sobre ninguno de los dos. Este paquete responde la misma
pregunta con **relaciones**, que es lo único que un modelo puede usar: "la costa está a 95 km
al oeste", "el terreno sube 1 505 m en 25 km", "Santiago está a 2 km al ENE".

```
LOCATION  33.4489S 70.6693W  (earth)
SURFACE   land · high plain · 579 m
TERRAIN   slope 1° facing WSW · local relief 1505 m
COAST     ~95 km W
NEAR      Santiago 2 km ENE (5.7M) · San Bernardo 17 km S (247k)
SUN       down 75.8° · solar time 00:15
```

Seis líneas, ~70 tokens, sin red.

## Por qué no es un cliente de Google Maps

| | Maps API | este paquete |
|---|---|---|
| Red | obligatoria | ninguna |
| API key / cuota | sí | no |
| Costo por llamada | sí | cero |
| Respuesta | geometría o imagen | hechos en texto |
| Determinismo | no garantizado | mismos bytes siempre |
| Auditable por un humano | no | sí, ver abajo |
| Otros cuerpos celestes | no existen | `Body` ya es genérico |

El determinismo es el punto que más se subestima: es lo que permite usar esto **dentro de un
eval o de un test de regresión**. Una API viva no sirve para eso porque su respuesta cambia
sin que cambie tu código.

## Auditabilidad

`renderView` dibuja la misma consulta como grilla de caracteres, desde los mismos datasets y
la misma proyección que usó `describeLocation`. Un humano puede **mirar** lo que el modelo
recibió y verificar si era cierto.

Ninguna API de mapas ofrece eso: te da o bien un PNG que el modelo no lee, o bien GeoJSON que
el humano no lee. Acá es un solo frame con dos lectores.

Que esto sea posible es consecuencia directa de una restricción del proyecto: `@glyphsphere/core`
no toca el DOM, así que el pipeline completo corre en Node sin canvas.

## API

```ts
import { earth } from '@glyphsphere/bodies';
import { describeLocation, formatLocation, loadEarthData, renderView } from '@glyphsphere/agent';

const { heightmap, places, land } = await loadEarthData();

// Hechos en un punto.
console.log(formatLocation(describeLocation([-70.6693, -33.4489], earth, { heightmap, places, land })));

// El mismo lugar, dibujado.
console.log(renderView(earth, { centre: [-70.6693, -33.4489], altitudeKm: 3000, heightmap, places, land }).text);
```

`describeLocation` devuelve el objeto estructurado; `formatLocation` es solo la serialización
compacta para un prompt.

## Servidor MCP

```bash
pnpm --filter @glyphsphere/agent mcp
```

Expone dos herramientas: `describe_location` y `render_view`. El repositorio trae un
`.mcp.json` en la raíz, así que Claude Code lo detecta solo.

Sin dependencias: MCP sobre stdio es JSON-RPC en líneas, y los tres métodos que necesita un
servidor de herramientas están en `src/mcp.ts`.

## Precisión, dicha en voz alta

Los datos son Natural Earth y ETOPO1. Eso fija los límites, y el paquete los reporta en vez de
esconderlos:

- **Elevación**: ETOPO1 a 4096x2048, ~9.8 km por texel en el ecuador. Bogotá da 2 624 m contra
  2 640 m reales.
- **Tierra/agua**: por polígonos de costa Natural Earth 10m, que generaliza la línea de costa
  cerca de 1 km. Cuando el punto cae dentro de esa banda, la respuesta **lo dice**
  (`shorelineUncertain`) en vez de afirmar con confianza algo que el dataset no sabe.
- **Distancia a la costa**: del heightmap, así que léase "aproximadamente". Un error de 5 km
  nunca cambia la pregunta que se está haciendo, que es "¿esto es costero o interior?".
- **Sol**: NOAA de baja precisión, con ecuación del tiempo. El mediodía solar no es las 12:00
  del reloj y acá no se finge que sí.

No hay calles, ni edificios, ni nombres de barrio: eso es la Fase 6 del roadmap. Esto responde
preguntas de escala regional, no de escala de cuadra.

## Comprobación

```bash
pnpm --filter @glyphsphere/agent probe 4.711 -74.0721
pnpm --filter @glyphsphere/agent probe 4.711 -74.0721 --view 3000
```
