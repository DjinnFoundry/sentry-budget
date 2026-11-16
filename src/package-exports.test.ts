import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

// Con solo la condicion `import`, un consumidor que carga el paquete como
// CommonJS (tsx sobre una app sin `"type": "module"`, por ejemplo) muere con
// ERR_PACKAGE_PATH_NOT_EXPORTED: ninguna condicion de `require` casa. `default`
// es la condicion que Node prueba siempre, y apunta al mismo ESM, que un
// `require` de Node 22 o posterior carga sin flag.
describe('exports de package.json', () => {
  it.each(Object.entries(pkg.exports))('%s resuelve tambien sin la condicion import', (_ruta, condiciones) => {
    expect(condiciones).toHaveProperty('default', condiciones.import);
    expect(Object.keys(condiciones).at(-1)).toBe('default');
  });
});
