import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*',
  // El proxy vive en la raíz porque es donde Vercel busca las funciones, así que no cae bajo
  // ningún paquete. Se le da su propio proyecto en vez de dejarlo sin probar.
  { test: { name: 'api', include: ['api/**/*.test.ts'] } },
]);
