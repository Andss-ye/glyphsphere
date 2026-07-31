<div align="center">

# glyphsphere

**Un planeta navegable, hecho de caracteres.**

<img src="./project-logo.png" alt="Project Logo" width="200" />

Platanus Build Night — Bogotá @ Buk

</div>

---

Hacker:

- Andrew ([@Andss-ye](https://github.com/Andss-ye))

## Qué es

`glyphsphere` dibuja la Tierra en una grilla de caracteres monoespaciados. Arrastrás para girar el
planeta, hacés zoom con la rueda, y seguís bajando hasta que el globo deja de verse y estás sobre
una calle — todo con la misma proyección continua y el mismo modelo de interacción.

No es un conversor de imágenes a ASCII: un conversor toma píxeles y elige caracteres por
luminancia, mientras que `glyphsphere` **conoce la geometría** (sabe que eso es una costa, que
aquello es un río, que esa banda es una curva de nivel) y elige cada carácter porque significa
algo. Combina tres registros de glifo con roles fijos — braille para líneas finas, cuadrantes para
bordes de área, ASCII semántico para relleno y marcadores.

## Características

- **Zoom continuo** de 292 km a **4 m por celda** con una sola proyección, sin transiciones ni saltos
- **Realce hipsométrico** con bandas, curvas de nivel, realce solar y sombra costera
- **Ciudades y labels** con resolución de colisiones, sin taparse entre sí
- **Red vial y huella urbana** por debajo de 150 km, en geometría real
- **Calles reales de OpenStreetMap** en braille al acercarse a una ciudad — Bogotá, Tokio, Nueva York
- **Funciona offline** — Natural Earth y ETOPO1 incluidos, sin API keys y sin red en runtime
- **Y con red, cobertura ilimitada** — cualquier ciudad se descarga de OSM en el momento; si no hay
  red, o si OSM no responde, el mapa sigue con lo que trae. La red nunca es un requisito
- **Preparado para otros cuerpos** — la Tierra no está cableada en ningún lado; `Body` es un tipo,
  no una constante, y un test dedicado falla si algo hardcodea una constante de la Tierra en el core
- **Dentro del presupuesto de 10 ms de CPU** por frame, medido con la cámara en movimiento
- **Contexto geoespacial para agentes de IA** — servidor MCP incluido, ver abajo

El zoom llega hasta la cuadra: a 200 m de altitud una celda cubre 4 m, y lo que se dibuja ahí es la
red vial real de OpenStreetMap. Las tres ciudades horneadas ocupan 1.4 MB en total y **no tocan la
red en runtime**; fuera de ellas, si hay conexión, la zona se descarga en el momento por la misma
ruta de código, así que una ciudad descargada se dibuja igual que una horneada. Agregar una ciudad
al build es una línea. Lo que falta son los edificios; números medidos en
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Para agentes de IA

Como el pipeline **conoce la geometría** en vez de promediar píxeles, la misma consulta puede
responderse en texto en lugar de en glifos. `@glyphsphere/agent` hace eso:

```
LOCATION  33.4489S 70.6693W  (earth)
SURFACE   land · high plain · 579 m
TERRAIN   slope 1° facing WSW · local relief 1505 m
COAST     ~95 km W
NEAR      Santiago 2 km ENE (5.7M) · San Bernardo 17 km S (247k)
SUN       down 75.8° · solar time 00:15
```

~70 tokens, sin red, sin API key, y **determinista** — lo que lo hace usable dentro de un eval.
Trae un servidor MCP sin dependencias (`describe_location`, `render_view`) que se enchufa a
Claude Code, Claude Desktop o Cursor.

Lo que no tiene ningún otro mapa: el mismo `render` dibuja la consulta como grilla de
caracteres, así que **un humano puede mirar exactamente lo que el modelo recibió**.

```bash
pnpm --filter @glyphsphere/agent probe 4.711 -74.0721
```

Detalle completo, incluida la comparación con una API de mapas comercial y las limitaciones de
precisión de los datasets, en [`packages/agent/README.md`](packages/agent/README.md).

## Paquetes

Monorepo pnpm. `core` no depende de nada del workspace; el resto se apila sobre él.

| Paquete | Qué hace |
|---|---|
| [`@glyphsphere/core`](packages/core) | Grid, Camera, Projection, LOD, los tres registros de glifo, LayerStack, atlas de fuente. Sin DOM. |
| [`@glyphsphere/bodies`](packages/bodies) | El tipo `Body` y el perfil de la Tierra (radio, bandas, paleta, rotación). |
| [`@glyphsphere/layers`](packages/layers) | Capas: océano, relieve, landmask, ríos/lagos, fronteras, graticule, terminador, ciudades. |
| [`@glyphsphere/data`](packages/data) | Scripts que generan los assets de `assets/earth/` desde Natural Earth, ETOPO1 y OpenStreetMap. |
| [`@glyphsphere/agent`](packages/agent) | Contexto geoespacial en texto para LLMs + servidor MCP. |
| [`@glyphsphere/renderer-canvas`](packages/renderer-canvas) | Backend Canvas2D. |
| [`apps/playground`](apps/playground) | La demo interactiva que corre `pnpm dev`. |

Las restricciones de diseño del proyecto viven en [`CLAUDE.md`](CLAUDE.md).

## Instalación rápida

```bash
pnpm install
pnpm data:build     # ~16 MB de Natural Earth + ETOPO1; no están en git
pnpm dev            # playground en :5173
```

Servidor MCP y CLI de consulta puntual, en [`packages/agent/README.md`](packages/agent/README.md).

## Estado

En desarrollo hacia v1. El roadmap avanza por fases, citadas como `Fase N` en el código:

- ✅ Fase 1 — proyección satelital y disco del planeta a cualquier altitud
- ✅ Fase 2 — landmask (tierra vs. agua)
- ✅ Fase 3 — navegación: arrastrar para girar, zoom continuo con la rueda
- ✅ Fase 4 — relieve batimétrico muestreado (no una profundidad nominal constante)
- ✅ Fase 5 — ciudades y labels con resolución de colisiones
- ✅ Fase 6 — escala urbana: red vial y huella construida, offline
- ✅ Fase 7 — campo de visión: el zoom deja de seguir al horizonte y llega a 4 m/celda
- ✅ Fase 8 — calles reales de OSM en braille, horneadas y offline
- ✅ Fase 9 — assets a un tercio, frame sin picos, y cobertura en línea opcional
- ⬜ Edificios, y tiles genéricos para cubrir el planeta sin enumerar ciudades

## Contribuir

Leé [`CLAUDE.md`](CLAUDE.md) primero: contiene las restricciones de diseño del proyecto (registros
de glifo fijos, nada de geometría 3D, `core` sin DOM, etc.), y la mayoría de los PRs rechazados lo
son por romper una.

## Licencia

MIT. Fuente Iosevka bajo SIL OFL. Datos de [Natural Earth](https://www.naturalearthdata.com/)
(dominio público), GEBCO y ETOPO1, y de [OpenStreetMap](https://www.openstreetmap.org/copyright)
(© contribuidores de OpenStreetMap, ODbL) para la escala de calle.
