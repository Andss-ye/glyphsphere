# ROADMAP

Fases y trabajo futuro. Las fases están citadas como `Fase N` en comentarios del código.

## Fases

| | Fase | Estado |
|---|---|---|
| 1 | Proyección satelital y disco del planeta a cualquier altitud | ✅ |
| 2 | Landmask (tierra vs. agua) | ✅ |
| 3 | Navegación: arrastrar para girar, zoom continuo con la rueda | ✅ |
| 4 | Relieve batimétrico muestreado, curvas de nivel, realce solar | ✅ |
| 5 | Lugares y labels con resolución de colisiones | ✅ |
| 6 | Escala urbana: vías reales y huella de área construida | ✅ |
| 7 | Campo de visión: el zoom llega al suelo | ✅ |
| 8 | Calle real desde OpenStreetMap, en braille, offline | ✅ |
| 9 | Assets a un tercio, frame plano, y cobertura en línea opcional | ✅ |

La Fase 6 se resuelve **sin red en runtime**: los datasets de Natural Earth se descargan en
`pnpm data:build` y se hornean en `packages/data/assets/earth/`.

### Lo que la Fase 6 sí hace

Por debajo de 150 km entra `urbanLayer`: la red vial principal en braille (`LINE_CLASS.ROAD`) y
el contorno de las áreas construidas (`LINE_CLASS.URBAN`). Geometría real, offline, ~3.7 MB.

### Fase 7 — el campo de visión

El encuadre estaba atado al horizonte: `discRadiusRows` ajustaba **todo el disco del horizonte**
al viewport. Eso se ve bien desde órbita y se derrumba al bajar, porque el horizonte se cierra en
incidencia rasante y la lente implícita se abre hacia los 180°. Medido: **ni en `MIN_ALT_KM`
(200 m) una celda bajaba de 1.6 km**, con una cuadra midiendo 100 m.

La clave está en la propia derivación: el término radial de la proyección, `rho(c)`, es
exactamente `tan(alpha)` — el ángulo respecto del eje óptico. O sea que **ya era una cámara
estenopeica**, y encuadrar es elegir lente. Así que `rho_max = min(rho(horizonte), tan(fov/2))`:
el cuerpo cabe en el cuadro mientras sea lo bastante chico, y por debajo del cruce manda la
lente. `min` es continuo, así que no hay salto (test en `projection.test.ts`).

Escala resultante, rejilla 202x63, `fovDeg` 60 (`packages/layers/test/urban.test.ts` la fija):

| altitud | antes | ahora |
|---|---|---|
| 20 000 km | 268 km/celda | 292 km/celda (globo, igual) |
| 2 000 km | 143 km/celda | 42 km/celda |
| 150 km | 43 km/celda | 3 km/celda |
| 10 km | 11 km/celda | 199 m/celda |
| 0.2 km | **1 603 m/celda** | **4 m/celda** |

Consecuencia para las capas: el culling debe ir contra **el viewport**, no contra el horizonte
(`Projection.visibleGroundRad()`). Con lente estrecha los dos difieren en órdenes de magnitud, y
cullear al horizonte significa transmitir un continente para dibujar un barrio.

### Fase 8 — la calle real, desde OpenStreetMap

La cámara llegaba a 4 m por celda y no había nada que dibujar ahí: Natural Earth 10m son
troncales generalizadas a un kilómetro y ETOPO1 son 9.8 km por muestra. OSM sí tiene la calle.

**Sigue siendo offline.** La descarga es en build time (`build-streets.ts`, vía Overpass), igual
que Natural Earth y ETOPO1. En runtime se lee un archivo horneado.

| ciudad | asset | vías | KB/km² |
|---|---|---|---|
| Bogotá | 1.2 MB gz | 26 616 | 1.3 |
| Tokio | 2.9 MB gz | 61 084 | 3.6 |
| Nueva York | 1.3 MB gz | 14 158 | 1.7 |

Agregar una ciudad es **una línea** en `CITIES`: la capa las descubre por el manifiesto y elige
por bbox, sin saber cuáles son. El playground pide el tile cuando la cámara entra en él.

Formato binario (mismo criterio que `places-10m.bin.gz`: `JSON.parse` de varios MB bloquea el hilo
justo cuando el usuario navega). Coordenadas como u16 relativos al bbox — 0.5 m de resolución,
diez veces más fino que la celda más pequeña que la cámara dibuja.

Lo que hace que se lea como una ciudad, y no como una mancha:

- **El umbral de clase va en metros por celda, no en altitud.** Es la escala lo que decide si una
  malla residencial de 100 m de paso se lee como trama o como mancha. Atado a la altitud, el cuadro
  salía al 50-73 % de braille.
- **Los tramos de OSM se encadenan al hornear.** OSM parte cada vía en las intersecciones: la
  mediana de un tramo *primario* en Bogotá son 101 m. Encadenados, 33 429 tramos son 17 070
  polilíneas — más baratas de dibujar y mejor de adelgazar.
- **Relevo explícito con los contornos.** El pipeline calla los contornos por debajo de ~612 m por
  celda (donde pasan a trazar la interpolación de ETOPO1, no el suelo) y las calles arrancan justo
  ahí. Solapados sumaban 60 % de contornos sobre los Andes más 36 % de calles: 72 % de braille en
  el mismo cuadro.

Resultado medido sobre las tres ciudades: **4.5-8.7 ms** por frame y braille entre **14 % y 49 %**,
por debajo del 50 % que `docs/AESTHETIC.md` pone como techo.

### Un error que vale documentar

El primer filtro descartaba los tramos más cortos que una celda. Parecía sensato — no dibujes lo
que no se puede leer — y era destructivo: como OSM parte las vías, el 96 % de las primarias mide
menos de 600 m, así que a 20 km desaparecía casi toda la red. El render salía *limpio y rápido*
precisamente porque faltaba lo que había que dibujar. La longitud de un tramo no dice nada de la
importancia de la vía; para eso está su clase.

### Fase 9 — el frame plano, los assets a un tercio, y la red como extra

Tres problemas que eran el mismo problema: **se estaban dibujando y guardando muchos más puntos de
los que la pantalla puede mostrar.**

**El pico.** Medido con un barrido de zoom continuo (`bench/zoom-sweep.ts`, que busca
discontinuidades en vez del peor caso), la capa de calles pasaba de 0 a 4.70 ms al cruzar los
20 km y el frame de 4.8 a 8.8 ms — un +84 % "de la nada". Instrumentada, la causa no era el
culling (0.1-0.7 ms) sino el trazado (2.5-5.8 ms), proporcional a los puntos emitidos.

| | antes | ahora |
|---|---|---|
| Bogotá, todo el descenso | 4.8 - 8.8 ms | **4.8 - 6.9 ms** |
| Tokio | — | 5.1 - 8.5 ms |
| Nueva York | — | 6.2 - 9.1 ms |

Tres arreglos, cada uno con su test:

1. **Simplificación al hornear**, Douglas-Peucker con tolerancia de 2 m — la subcelda del zoom más
   cerrado, o sea el límite de lo que la pantalla distingue con la cámara en el suelo. Quita el
   63 % de los puntos sin quitar una sola calle.
2. **`strokeLine(..., dense)`**: apaga el resampleo adaptativo de d3 para geometría cuyo parche es
   lo bastante chico como para que la proyección sea afín sobre él. −30 % del coste de la capa.
   Cuidado con la justificación fácil: la premisa **no** es "los vértices están más juntos que una
   subcelda" — la simplificación emite cuerdas de hasta 6.5 km por una avenida recta. Es la
   extensión del parche lo que lo hace exacto, y `streets.test.ts` lo verifica comparando cada
   subcelda contra el cuadro resampleado.
3. **El agua en dos clases.** A 419 m por celda el agua emitía 7 234 puntos contra 4 886 de todas
   las calzadas juntas, y eran drenajes que no cubrían ni una subcelda. Un río se dibuja siempre;
   una quebrada espera a que la celda baje de 100 m.

**Los assets.** Coordenadas como delta con zigzag varint en vez de pares u16 absolutos, sobre una
rejilla de 1 m cuyo tamaño va en la cabecera — que es lo que además deja pedir un cuadro de
tamaño arbitrario sin inventar otro formato.

| | antes | ahora |
|---|---|---|
| Bogotá | 1.2 MB | **384 KB** |
| Tokio | 2.9 MB | **843 KB** |
| Nueva York | 1.3 MB | **232 KB** |
| total | 5.3 MB | **1.4 MB** (−73 %) |

**La red, como extra y nunca como requisito.** `fetchOnlineStreets` descarga de Overpass una zona
que nadie horneó. El orden importa y es el que dice la propuesta del proyecto: primero el tile
horneado, que es el piso garantizado; solo si no hay uno para este punto se pregunta a OSM; y todo
fallo — sin red, espejo caído, 504, zona vacía — devuelve `null` y deja al mapa dibujando lo que
ya tiene. Los tests del modo en línea son deliberadamente **negativos**: afirman que nunca puede
ser la razón de que el mapa deje de funcionar.

Horneado y descarga comparten una sola ruta de código (`loaders/streets-osm.ts` +
`loaders/streets-bin.ts`, con codificador y decodificador en el mismo archivo). No es prolijidad:
es lo que garantiza que una ciudad descargada y una horneada se dibujen igual. Verificado extremo
a extremo contra Overpass real — Madrid, 9 252 vías, 163 KB, 2.3-3.2 ms por frame.

El cuadro en línea es de 0.07° de medio lado, el mismo que usa cada sub-cuadro del horneado, y por
la misma razón: el cuadro metropolitano entero devuelve 504.

#### El consumo estaba en el backend, no en el pipeline

Todo el trabajo de presupuesto de frame de este proyecto mide `pipeline.render`, y ahí se cumplen
los 10 ms. Pero **poner la rejilla en pantalla no se estaba midiendo**, y era donde estaba el
gasto: `present()` hacía un `fillText` por celda no vacía. En una rejilla de terminal real —
274x77 en una pantalla de 1080p — son unas 20 000 llamadas a `fillText` por cuadro, cada una con
su medición y composición de texto, más 20 000 strings de `String.fromCodePoint` y 20 000 objetos
de `grid.get`. La demo calentaba la máquina.

Estaba anotado como deuda en el propio renderer desde el principio (*"swap in the tinted-atlas
trick if profiling shows this is over budget on a real grid size"*). Lo mostró.

- **Los glifos se copian, no se componen.** Cada carácter sale de una hoja ya rasterizada en su
  color (`tinted-sheets.ts`), rellenada bajo demanda. Una celda cuesta un `drawImage` — una copia
  de píxeles que la GPU acelera — en vez de tipografía.
- **Solo se repinta lo que cambió.** La rejilla vive en un lienzo propio que persiste entre
  cuadros; se compara contra el anterior leyendo `grid.cells` directamente, sin asignar nada.
- **El panel se actualiza a 8 Hz, no a 60.** Son una veintena de escrituras al DOM para mostrar
  números que nadie lee sesenta veces por segundo.

Y dos más, sobre la comparación entre cuadros:

- **Se compara de palabra en palabra, no de byte en byte.** Una celda son exactamente cuatro
  bytes, así que verla como `uint32` compara las cuatro de una vez: en 274x77 son 21 000
  comparaciones en lugar de 84 000.
- **Cuando cambia más de la mitad del cuadro se borra el lienzo entero de una vez.** Repintar el
  fondo celda a celda cuesta un `fillRect` *además* del glifo — dos operaciones donde puede haber
  una — y arrastrando cambia casi todo, que es justo cuando importa.

Y la lección de fondo: **el contador del panel medía media tarea y por eso tranquilizaba**. Decía
5 ms mientras el cuadro real costaba mucho más. Ahora muestra `pipeline + present` por separado y
avisa pasando de 16 ms, que es el presupuesto de verdad a 60 fps.

`packages/renderer-canvas/test/present.test.ts` cuenta operaciones de canvas contra un contexto
falso — no mide tiempo, que dependería de la máquina, sino las llamadas que lo determinan: cero
`fillText` por celda, y cero repintados cuando el cuadro no cambia.

#### Lo que costó que el modo en línea funcionara de verdad

La primera versión pasaba todos sus tests y **no funcionaba en el navegador**: lluvia de peticiones
a `interpreter` marcadas *canceled*. Cuatro defectos, ninguno visible desde un test con mock,
porque el problema no estaba en la función sino en cómo se la llamaba y en cómo se comporta un
servicio público real.

1. **El patrón de llamada, no la función.** `fetchOnlineStreets` se llamaba desde el bucle de
   render — sesenta veces por segundo — y al fallar liberaba la zona para reintentar. Con un fallo
   rápido (espejo caído, 429) eso son decenas de consultas por segundo contra un servicio gratuito.
   La política vive ahora en `createOnlineStreetSource`: una consulta en vuelo, espera de 20 s /
   90 s / 5 min, y rendición. `request()` es barato y se puede llamar por frame.
2. **Se le mentía al servidor sobre el plazo.** La consulta llevaba `[timeout:180]` y el cliente
   abortaba a los 30 s. Overpass reparte turnos por IP contando el trabajo *pedido*, así que colgar
   antes no libera nada: gasta el turno igual. Con unas pocas así, `overpass-api.de` pasó a
   rechazar la conexión de esta máquina al instante mientras otros espejos seguían respondiendo.
   Ahora el plazo del cliente se le declara al servidor, y son 60 s — medido, una consulta real
   llegó a tardar **58.9 s** en completarse cayendo por espejos saturados.
3. **`null` significaba dos cosas.** "Aquí no hay calles" y "no se pudo preguntar" salían iguales,
   así que reintentar el mar abierto costaba tres consultas para redescubrir que no hay nada.
   Ahora son `empty` (definitivo) y `unavailable` (lo único que merece reintento).
4. **Overpass avisa de sus errores con HTTP 200**, `elements` vacío y un `remark`. Sin mirarlo, una
   consulta que revienta en el servidor se lee como zona vacía — y eso es definitivo.
5. **Un espejo que rechaza la conexión se reintentaba en cada consulta.** Ahora se aparta cinco
   minutos: sin eso la consola se llena de `net::ERR_CONNECTION_REFUSED` y cada intento gasta el
   tiempo del usuario antes de llegar al espejo que sí responde. Si todos están apartados se
   intenta igual — rendirse garantiza no dibujar nada.
6. **Se pedían 19 MB para producir un tile de 44 KB.** `out geom;` devuelve cada vía con todas sus
   etiquetas — nombre, superficie, carriles, velocidad, iluminación — y las coordenadas como
   objetos `{lat, lon}`. Pasando por `convert` para quedarse con una sola etiqueta y geometría
   GeoJSON, el mismo cuadro baja un 59 %, y con el cuadro al tamaño que el horneado ya había
   probado (0.07°, no 0.14°) queda en **1.7-3.5 MB**. No es solo ancho de banda: Overpass reparte
   turnos por IP cobrando el trabajo pedido, así que una consulta obesa se paga en 504 en la
   siguiente. Medido después: **París entero en 3.7 s**, contra 26-58 s antes.
7. **El plazo era por espejo, no por búsqueda.** Tres intentos de 25 s son 75 s antes de poder
   decir que no hay datos, y quien mira el mapa no distingue eso de que esté colgado. Ahora el
   presupuesto es de toda la búsqueda.
8. **Rotar el espejo de arranque hacía daño.** Se hizo para repartir carga, pero dos de los tres
   espejos públicos aceptan la conexión y no contestan: rotar a ciegas repartía peticiones a
   servidores que cuestan 25 s cada uno. El apartado por salud ya reparte la carga, y lo hace
   según cómo se están portando de verdad.
9. **Se descubría que un espejo estaba muerto con la consulta real.** Su endpoint `/api/status`
   los separa en menos de un segundo — medido, 0.65 s el que funciona contra el plazo agotado en
   los otros dos — y de paso dice cuándo tendrá turno libre, así que se le cree y se le espera en
   vez de insistir. Si ninguno tiene turno, se admite al momento en lugar de esperar el plazo
   entero para acabar en lo mismo.

10. **El sondeo no se identificaba, y se envenenaba solo.** Mismo 406 del punto 2, en el endpoint
    nuevo: sin `User-Agent` Overpass rechaza también el estado, así que el sondeo daba por muertos
    a los tres espejos y la búsqueda se rendía en medio segundo teniéndolos todos disponibles. Lo
    peor fue cómo se escondió: comprobarlo a mano con `curl` decía 200, porque `curl` sí manda un
    User-Agent. Hay test de regresión.

11. **Un cuadro no cubre la pantalla, y eso era una regresión propia.** Achicarlo a 0.07° arregló
    el 504 y rompió otra cosa: a esa medida cubre el **7 %** del ancho visible a 25 km de altitud
    y el 17 % a 10 km. El tile llegaba perfecto y en pantalla no se veía nada, porque era un
    parche diminuto en mitad de una vista mucho más ancha — que es exactamente lo que se reportó
    como "cargó Medellín pero en Buenos Aires no aparece nada". Ahora se piden los cuadros que
    cubren la vista, **uno por vez y del centro hacia afuera**, así que lo que se está mirando
    llega primero y la cuota de Overpass no se encola.
12. **El panel afirmaba que había datos donde no los había.** Sumaba todos los tiles cargados, así
    que decía "Medellín, 3 400 vías" estando sobre Buenos Aires. Ahora cuenta solo los que cubren
    el punto bajo la cámara.

Queda una limitación honesta: a 25 km de altitud cubrir la vista entera serían ~49 consultas, que
no se le piden a un servicio gratuito. La cobertura en línea es completa desde unos 10 km hacia
abajo — que es donde se miran calles — y parcial por encima.

**Lo que sigue sin depender de nosotros.** Los tres espejos son servidores públicos gratuitos y se
saturan de verdad: midiéndolos en un mismo minuto, dos aceptaban la conexión sin contestar nunca y
el tercero repartía turnos. Con todo lo anterior, una ciudad cargada cuesta **2-4 s** y un fallo se
admite en **0.6-25 s** en vez de en tres minutos; pero que respondan no está en nuestra mano, y por
eso los tiles horneados son el piso y esto es el extra.

Y una trampa en la que caí eligiendo espejos: `overpass.osm.ch` responde en 0.6 s con 200 y CORS
correcto, pero es la instancia **suiza** y solo carga Suiza. A Madrid contesta 200 con cero
elementos. Un espejo regional no falla: miente, y su mentira es idéntica a "aquí no hay calles".
Lo validé mirando el código de estado en vez de contar elementos, que es exactamente el error que
el punto 4 describe. Los espejos por defecto son los tres mundiales, y el orden de arranque rota.

### Lo que sigue faltando

- **Edificios.** OSM los tiene; a 4 m por celda una manzana ocuparía celdas de verdad. Es el
  siguiente salto de realismo y el que más pesa en bytes.
- **Más ciudades horneadas.** Es una línea por ciudad, limitada por lo que Overpass sirva.
- **Persistir lo descargado.** `fetchOnlineStreets` ya devuelve los bytes junto al tile,
  precisamente para que quien llama los pueda guardar (IndexedDB, disco). Con eso una ciudad
  visitada una vez con red queda disponible sin ella, que es la forma natural de que la cobertura
  crezca sola sin romper la propuesta offline. Falta la política de expiración y de cuota.
- **Tiles genéricos** (`@glyphsphere/sources`) en vez de un cuadro por ciudad, para cubrir el
  planeta sin enumerarlo.
- **`land-10m` en `landmask`** sigue siendo el coste dominante restante (3.7 ms sobre Nueva York a
  400 km), y el arreglo de fondo sigue siendo tiling. Es lo único que queda fuera del trabajo de
  la Fase 9, que solo tocó la escala de calle.

### Presupuesto de frame

**Dentro de los 10 ms**, incluida la capa urbana y el zoom nuevo. Peor caso medido con la cámara
en movimiento sobre Bogotá, Tokio, Nueva York y Los Ángeles, stack completo:

| | peor caso |
|---|---|
| antes de todo esto (ya fuera de presupuesto) | 15.6 ms |
| Fase 6 + campo de visión, sin optimizar | 40.8 ms |
| culling contra el viewport, no contra el horizonte | 17.9 ms |
| span de interpolación según el limbo | 14.4 ms |
| descartar runs lejanas en los trazos | 11.5 ms |
| incidencia solar interpolada por spans | **10.0 ms** |

Bogotá y Los Ángeles quedan en ~7-8 ms, Tokio ~8.5, Nueva York ~9-10. `urbanLayer` aporta
+0.2 a +1.5 ms.

Los cuatro arreglos, cada uno con su test de regresión:

1. **Cullear contra el viewport** (`Projection.visibleGroundRad()`). Con lente estrecha, horizonte
   y viewport difieren en órdenes de magnitud.
2. **`fillElevationField` muestreaba 114 408 veces para 101 808 subceldas** — los spans compartían
   extremo y lo escribían dos veces. Además el ancho de span era una apuesta a dos bandas (span 8
   cuesta 5.3 ms a 1 km; span 64 cuesta 16.0 ms a 2 000 km), así que ahora se elige según si el
   limbo está en el cuadro, que es el único sitio donde la inversa no es suave.
   (`elevation-field.test.ts`, incluida una comparación contra un campo invertido exactamente.)
3. **Un trazo no tiene interior**, así que las runs fuera de vista se descartan en vez de
   adelgazarse — partiendo la polilínea, porque unir a través del hueco dibuja una cuerda
   atravesando la pantalla. (`resolveLine`, 6 tests en `culling.test.ts`.)
4. **El terminator invertía la proyección en cada celda** (12 726 por frame) para concluir casi
   siempre "es de día". Ahora interpola la incidencia por spans, con vuelta a exacto donde cambia
   rápido. El frame sale **idéntico** al exacto, celda por celda (`terminator.test.ts`).

Lo que queda sin resolver es el mismo que estaba documentado en
`packages/core/src/layers/types.ts`: `land-10m` en `landmask` es el coste dominante restante, y
el arreglo de fondo es tiling.

## Paquetes planeados que todavía no existen

No asumas que un import a estos resuelve — son intención, no código.

| Paquete | Para qué | Por qué todavía no |
|---|---|---|
| `@glyphsphere/renderer-webgl` | Backend WebGL2, un solo draw call por frame más uno para el limbo. Sería el backend default. | `renderer-canvas` alcanza el presupuesto de 10 ms en las vistas actuales. |
| `@glyphsphere/renderer-dom` | Backend `<pre>`. Accesibilidad, export a texto, snapshots de test. | El core ya corre sin DOM, así que los snapshots se hacen sobre `Grid` directamente. |
| `@glyphsphere/react` | Componente `<Glyphsphere />` y hooks. | La superficie pública todavía se está moviendo; envolverla ahora congela una API que no está estable. |
| `@glyphsphere/sources` | Fuentes de tiles vectoriales: PMTiles, XYZ. Habilitaría calle-por-calle real vía OSM. | Rompe la propuesta offline salvo que los tiles se horneen; ver abajo. |

Dependencias que solo se justifican cuando llegue `sources`: `pmtiles`,
`@mapbox/vector-tile`, `pbf`.

## Ejemplos

`examples/flight-radar` — demuestra que la librería acepta datos externos en tiempo real.
Opcional y no empezado. Es lo único del proyecto que sí necesita red, y por eso es un *ejemplo*
y no parte de la librería.

## Trabajo futuro sin fase asignada

- **Calle por calle real (OSM).** Requiere `@glyphsphere/sources` + tiles PMTiles horneados por
  ciudad. Mantiene la propuesta offline solo si los tiles se empaquetan; un XYZ en vivo la rompe.
- **Otros cuerpos.** `Body` ya es genérico y un test impide que entren constantes de la Tierra al
  core. Falta el perfil de la Luna y sus datasets.
- **Escena multi-cuerpo.** `Scene.visibleBodies()` ya devuelve una lista y el pipeline ya itera
  sobre ella. Falta decidir la composición cuando dos cuerpos se solapan en pantalla.
- **Vistas oblicuas.** `CameraState` necesitaría un solo campo nuevo, `tiltDeg`.
