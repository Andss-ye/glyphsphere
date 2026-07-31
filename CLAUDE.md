# CLAUDE.md

Instrucciones para Claude Code sobre este repositorio. Léelo completo antes de tocar código.

---

## Qué es este proyecto

`glyphsphere` es una **librería de renderizado de cuerpos celestes en una grilla de caracteres**.
Dibuja un planeta con ASCII, braille y bloques de cuadrante combinados, con zoom continuo desde
órbita alta hasta nivel de calle y navegación tipo canvas.

El primer y único cuerpo implementado es la Tierra, y tiene que quedar excepcionalmente bien
antes de que se agregue cualquier otro. Pero **la arquitectura no tiene la Tierra cableada**: el
radio, los datasets, la rampa hipsométrica y la atmósfera son propiedades de un `Body`
(`packages/core/src/body.ts`), no constantes globales. Esto no es aspiracional: un test
(`packages/core/test/no-earth-constants.test.ts`) escanea `core/src` y falla si aparece
`6371`, `298.257`, `'earth'` como literal, o cualquier otra constante de la Tierra. La Luna y una
escena multi-cuerpo son trabajo futuro, y el diseño de hoy tiene que dejarles lugar sin pagar
complejidad hoy.

**La primitiva fundamental es la grilla de caracteres.** Todo —continentes, relieve, curvas de
nivel, ciudades, labels, HUD— se escribe en la misma `Grid`. No hay overlays de DOM flotando
encima del mapa.

### Esto no es un conversor de imágenes a ASCII

Es la distinción más importante del proyecto y la que hay que defender en cada decisión. Un
conversor toma píxeles y elige caracteres por luminancia. Nosotros **conocemos la geometría**:
sabemos que eso es una costa, que aquello es un río, que esa banda es la curva de nivel de
2 000 m. Cada carácter se elige porque significa algo, no porque el promedio de brillo cayó en
un rango.

Si alguna vez una decisión de render se puede describir como "promediar luminancia y buscar en
una rampa", está mal.

La misma razón por la que esto funciona hace posible `@glyphsphere/agent`: si el pipeline conoce
la geometría en vez de promediar píxeles, la misma consulta se puede responder en texto ("la
costa está a 95 km al oeste") en lugar de en glifos. Es un paquete real del monorepo, no una
idea — ver el mapa de paquetes más abajo.

---

## Prioridades

En este orden. Cuando algo compite, gana lo de más arriba.

1. **Calidad del planeta.** Que la Tierra se vea detallada, correcta y hermosa a todo zoom.
2. **Calidad de la librería.** API chica, estable, documentada, que otro dev pueda extender.
3. **Rendimiento.** Dentro del presupuesto de frame, siempre.
4. **Extensibilidad a otros cuerpos.** Sin cablear la Tierra, sin construir el sistema solar hoy.
5. **Aplicaciones de ejemplo.** No se trabaja en ellas salvo que quede tiempo sobrante.

---

## Restricciones duras

No se negocian. Si una tarea parece requerir romper una, para y pregunta.

1. **Tres registros de glifo, con roles fijos.** Braille dibuja líneas. Cuadrantes dibujan bordes
   de área. ASCII rellena áreas y pone marcadores y texto. No se usa braille como textura de
   relleno ni ASCII para linework fino. Tablas y selección de glifo en
   `packages/core/src/raster/registers/`.
2. **Nada de geometría 3D.** No hay meshes, no hay Three.js, no hay esferas texturizadas. La GPU
   solo dibuja quads con glifos. La proyección es matemática 2D en CPU
   (`packages/core/src/projection/satellite.ts`).
3. **Un solo draw call por frame, más uno para el limbo.** Si el conteo de draw calls sube por
   encima de esto, es un bug.
4. **El core no toca el DOM.** `@glyphsphere/core` debe correr en un Web Worker, en Node y en
   React Native sin cambios. Cero referencias a `window`, `document`, `HTMLElement`.
5. **Nada de constantes de la Tierra en `core`.** No existe `EARTH_RADIUS_KM`. Existe
   `body.radiusKm`. Enforced por `no-earth-constants.test.ts` (ver arriba).
6. **Paleta indexada de 16 colores.** Los colores se referencian por índice (`PAL.*` en
   `packages/core/src/palette/palette.ts`), nunca por RGB en el pipeline de render.
7. **Presupuesto de frame: 10 ms en CPU.** Hay benchmarks en `packages/core/bench/` y
   `packages/layers/bench/`; no romper ese presupuesto en más de 30 %.

---

## Comandos

```bash
pnpm install            # pnpm >= 9
pnpm dev                # playground en :5173 (apps/playground)
pnpm build              # build de todos los paquetes
pnpm test               # vitest (todo el workspace, vía vitest.workspace.ts)
pnpm test:visual        # snapshots de grilla en texto plano
pnpm bench              # benchmarks por etapa del pipeline (core y layers)
pnpm data:build         # regenera assets: Natural Earth, ETOPO1 y calles OSM por ciudad.
                        # Descarga en build time; en runtime nunca hay red. Es reanudable:
                        # Overpass a veces satura, y una ciudad entra completa o se omite.
pnpm font:build         # compila el subset de Iosevka (fonts/build.ts)
pnpm typecheck          # tsc -b sobre todo el workspace
pnpm lint               # eslint .
```

Un solo paquete o test:

```bash
pnpm --filter @glyphsphere/core test
pnpm --filter @glyphsphere/core exec vitest run test/reduce.test.ts
pnpm --filter @glyphsphere/agent probe 4.711 -74.0721   # CLI de @glyphsphere/agent
pnpm --filter @glyphsphere/agent mcp                    # servidor MCP por stdio
```

Antes de dar por terminada cualquier tarea: `pnpm typecheck && pnpm test && pnpm lint`.

---

## Mapa de paquetes

```
packages/
  core/              @glyphsphere/core             Grid, Camera, Projection, LOD, los tres
                                                    registros, LayerStack, atlas. Cero DOM.
  bodies/            @glyphsphere/bodies           Tipo Body + perfil de la Tierra (radio,
                                                    bandas, paleta, datasets, rotación).
  layers/             @glyphsphere/layers          Capas: ocean, relief, landmask, hydro,
                                                    urban, streets (OSM), borders, graticule,
                                                    terminator, places.
  data/              @glyphsphere/data             Scripts que generan assets/earth/ desde
                                                    Natural Earth (world-atlas), ETOPO1 y
                                                    OpenStreetMap (Overpass). La clasificación,
                                                    el encadenado y el formato de calles NO viven
                                                    acá: están en layers, compartidos con el
                                                    origen en línea. Por eso data → layers.
  agent/             @glyphsphere/agent            Contexto geoespacial en texto para LLMs:
                                                    describe_location + render_view, servidor
                                                    MCP incluido. Ver packages/agent/README.md.
  renderer-canvas/   @glyphsphere/renderer-canvas  Backend Canvas2D.

apps/
  playground/        @glyphsphere/playground       Demo interactiva (Vite, :5173).
```

Dependencias reales: `bodies` → `core`. `layers` → `core` + `bodies`. `data` → `layers` +
`bodies`. `agent` → `core` + `bodies` + `layers` + `data`. `renderer-canvas` → `core`.
**`core` no depende de nadie del workspace.**

### Offline es el piso, la red es un extra

`fetchOnlineStreets` descarga de OpenStreetMap una zona que nadie horneó, y no contradice la
propuesta offline **siempre que el orden se respete**: primero el tile horneado, y solo si no hay
uno se pregunta a la red. Todo fallo devuelve `null` y el mapa sigue dibujando lo que tiene. Los
tests del modo en línea son negativos a propósito: afirman que nunca puede ser la razón de que el
mapa deje de funcionar. Si alguna vez una capa *necesita* red para dibujar, eso es un bug.

---

## Documentación

Lo único que existe en `docs/` es **`docs/ROADMAP.md`**: fases, paquetes planeados que todavía no
existen, y los límites medidos del sistema. Empezá ahí si no sabés qué hacer.

Vas a encontrar comentarios en el código (`body.ts`, `ladder.ts`, `defaults.ts`, tests, scripts de
`packages/data`) que citan `docs/ARCHITECTURE.md`, `docs/BODIES.md`, `docs/RELIEF.md`,
`docs/CAMERA.md`, `docs/DATA.md` como si existieran: **no existen**. Son la intención original. El
código fuente y sus comentarios son la fuente de verdad — no inventes el contenido de esos
archivos ni asumas que están escritos en otro lado.

---

## Límites medidos que hay que conocer antes de prometer nada

Medidos, no estimados. Tablas y método en `docs/ROADMAP.md`.

1. **El encuadre es una lente, no el horizonte.** `rho(c)` de la proyección *es* `tan(alpha)`, así
   que encuadrar es elegir campo de visión: `rho_max = min(rho(horizonte), tan(fov/2))`, en
   `projection/satellite.ts`. La cámara llega a 4 m/celda en `MIN_ALT_KM`. **Consecuencia que se
   olvida:** una capa debe cullear contra `projection.visibleGroundRad()`, nunca contra el
   horizonte — con lente estrecha difieren en órdenes de magnitud, y equivocarse costó 40 ms/frame.
2. **Cada dato tiene su escala, y hay que respetarla.** ETOPO1 son 9.8 km por muestra; Natural
   Earth 10m generaliza la costa a ~1 km; OSM sí resuelve la calle. Por eso los contornos se
   callan por debajo de ~612 m/celda (más allá trazan la interpolación, no el suelo) y las calles
   arrancan justo ahí. **Un umbral de detalle va en metros por celda, no en altitud** — la
   altitud depende del campo de visión y del tamaño de la rejilla; la escala es la magnitud real.
   Y no filtres geometría por su longitud: OSM parte las vías en las intersecciones, así que
   descartar tramos cortos borra la red en vez de despejarla.
3. **Medí en la rejilla que ve el usuario, no en una cómoda.** Es el error que más caro salió:
   los benches usaban 150x40 o 200x60 y reportaban 4-6 ms, mientras una ventana de 1080p con celda
   de 14 px son **274x77 — 21 098 celdas, casi el doble** — y ahí el mismo frame cuesta 8-12 ms.
   El pipeline escala con las celdas, así que una rejilla de bench chica no es una medida
   optimista: es otra medida. `zoom-sweep.ts` usa 274x77 por defecto.
   Con eso, el descenso completo sobre las tres ciudades va de **8.2 a 12.5 ms**, y lo que domina
   son dos costes fijos por celda: `reduce` (2.5-4.8 ms) y `relief` (2.3-3.0 ms). No supongas que
   estás dentro de presupuesto porque tu capa sea barata — **medí el stack completo**, con la
   cámara en movimiento (una cámara quieta usa la caché de geometría y no mide nada).
4. **Lo que cuesta un frame es la cantidad de puntos que se emiten, no el culling.** Instrumentado
   sobre la capa de calles: resolver la geometría son 0.1-0.7 ms y trazarla 2.5-5.8 ms. Antes de
   optimizar un recorrido, contá cuántos puntos llegan a `strokeLine` — y antes de guardar un
   punto, preguntá si la pantalla lo puede distinguir. Los assets de calles bajaron un 73 %
   simplificando a 2 m, que es la subcelda del zoom más cerrado.
5. **Un pico entre dos altitudes vecinas es un umbral mal puesto.** `packages/layers/bench/zoom-sweep.ts`
   barre el descenso completo por capa buscando discontinuidades, que es lo que se siente como que
   el frame "sube de la nada"; el peor caso solo no las muestra.
6. **El presupuesto de 10 ms es del pipeline, no del cuadro.** Poner la rejilla en pantalla cuesta
   aparte, y durante toda una fase no se midió: el panel decía 5 ms mientras `present` costaba
   mucho más haciendo un `fillText` por celda. Un contador que mide media tarea tranquiliza en vez
   de avisar. El panel del playground ahora muestra `pipeline + present`.
7. **Y el consumo no es el coste del cuadro, es el coste por segundo.** Un frame de 10 ms a
   sesenta por segundo tiene la CPU ocupada más de la mitad del tiempo y calienta un portátil en
   cuanto arrastrás. El playground dibuja como mucho a 30 fps (`MIN_FRAME_MS`), que es la mitad de
   trabajo y en un mapa de celdas de 7x14 px no se distingue. Antes de optimizar un milisegundo,
   preguntá cuántas veces por segundo se paga.

Dos patrones que ya se usan y conviene reusar antes de inventar otro:

- **Interpolar por spans lo que sale de `projection.fromCell`.** Invertir la proyección es el
  coste; el campo de elevación y el terminator lo hacen cada 8-64 celdas y comprueban linealidad
  en vez de asumirla. Los dos tienen test que compara contra el cálculo exacto.
- **Un trazo no tiene interior.** Para líneas, la geometría fuera de vista se descarta
  (`resolveLine`); solo un *relleno* necesita conservar lo lejano para seguir encerrando el área
  correcta (`resolveRing`). Confundirlos rompe el mapa: o sobra coste, o el continente bajo la
  cámara se vuelve océano.

---

## Convenciones de código

- **TypeScript estricto.** `strict`, `noUncheckedIndexedAccess`. Sin `any`.
- **Sin clases salvo para objetos con ciclo de vida** (`Grid`, `Camera`, `LayerStack`,
  `TileCache`). Todo lo demás son funciones puras.
- **Typed arrays en el hot path.** Nada de arrays de objetos. Cero asignaciones dentro del loop
  de render: los buffers se preasignan y se reusan.
- **Nombres de coordenadas con su espacio.** Nunca `x`, `y`, `pos` a secas. Usá `lonLat`,
  `screenPx`, `cellXY`, `subXY` (subcelda braille), `tileXY`. Los bugs de este proyecto son casi
  todos confusión de espacio de coordenadas.
- **Unidades en el nombre.** `altitudeKm`, `radiusPx`, `bearingDeg`, `frameMs`, `elevationM`.
- **Comentarios solo para el porqué.** La matemática de proyección y la codificación de braille
  sí llevan comentario con la derivación.

## Errores frecuentes en este proyecto

- **Relación de aspecto de celda.** Vive en un solo lugar (`packages/core/src/projection/aspect.ts`,
  `CELL_ASPECT`). No la repliques. Sin ella el planeta sale ovalado y las subceldas braille dejan
  de ser cuadradas.
- **Codificación de braille.** El orden de bits de los puntos 7 y 8 no sigue el patrón de los
  puntos 1 a 6. Usá la tabla de `packages/core/src/raster/registers/braille.ts`, no la deduzcas.
- **Culling del hemisferio oculto.** Todo punto testea visibilidad (`projection/visibility.ts`)
  antes de proyectarse. Objetos con altura propia (aviones, satélites) ven más allá del horizonte
  del suelo.
- **Mezclar registros en la misma celda.** Una celda tiene un registro y uno solo. La resolución
  de conflictos es por prioridad, en `packages/core/src/raster/reduce.ts`.
- **Reasignar typed arrays en resize.** Preasigná al máximo esperado y usá subvistas.
- **`getImageData` más de una vez por frame.** Una sola llamada, buffer reusado.
- **Asumir cobertura de fuente.** Braille y cuadrantes pueden faltar. El atlas
  (`packages/core/src/charset/atlas.ts`, `coverage.ts`) detecta glifos ausentes al construirse y
  activa el set de respaldo. No asumas que están.

---

## Qué NO hacer

- No agregues dependencias sin justificarlo. Runtime permitido hoy en el workspace: `d3-geo`,
  `d3-geo-projection`, `topojson-client`, `versor`, `world-atlas`.
- No metas React en `core`, `bodies`, `layers`, `data`, `agent` ni `renderer-canvas`.
- No pongas constantes ni datasets de la Tierra en `core`.
- No implementes features de fases del roadmap que no hayan sido pedidas sin preguntar primero.
- No "arregles" la matemática de proyección en `packages/core/src/projection/`. Está derivada y
  verificada por tests (`camera.test.ts`, `projection.test.ts`).
- No construyas la escena multi-cuerpo todavía. `Body` ya es genérico; una escena con más de un
  cuerpo simultáneo es trabajo futuro sin especificar aún.
