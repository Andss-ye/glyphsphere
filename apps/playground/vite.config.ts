import { defineConfig } from 'vite';
import overpass from '../../api/overpass.js';

/**
 * El servidor de desarrollo sirve el mismo `/api/overpass` que Vercel sirve en producción.
 *
 * Es el mismo módulo, no una copia: si en dev funciona y en el deploy no, es un problema de
 * despliegue y no de código. Vite lo monta como middleware y Vercel como función; los dos le pasan
 * un `IncomingMessage` y un `ServerResponse`, que es justo por lo que el proxy está tipado así.
 *
 * `use('/api/overpass', ...)` recorta el prefijo, de modo que al proxy le llega `/?data=...`. Le
 * da igual: solo lee la cadena de consulta.
 */
export default defineConfig({
  plugins: [
    {
      name: 'glyphsphere-overpass-proxy',
      configureServer(server) {
        server.middlewares.use('/api/overpass', (req, res) => {
          void overpass(req, res);
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use('/api/overpass', (req, res) => {
          void overpass(req, res);
        });
      },
    },
  ],
});
