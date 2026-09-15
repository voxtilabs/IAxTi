import { describe, expect, it } from 'vitest';
import { rutasConCandado } from '../lib/candados';

// El candado del menú (issue 215): qué rutas se marcan cuando el plan no
// incluye el módulo. Lo que se prueba es el CRUCE, que es donde me equivoqué
// primero — adivinando el módulo por el prefijo del permiso.

const MODULOS = [
  { id: 'crm', nav: [{ label: 'Contactos', path: '/contactos', permission: 'crm.contacts.read' }] },
  {
    id: 'automations',
    nav: [{ label: 'Automatizaciones', path: '/automatizaciones', permission: 'automations.manage' }],
  },
  {
    id: 'authorization',
    nav: [
      { label: 'API', path: '/ajustes/api', permission: 'apikeys.manage' },
      { label: 'Roles', path: '/ajustes/roles', permission: 'roles.read' },
    ],
  },
];

describe('rutasConCandado', () => {
  it('marca las rutas del módulo que el plan no incluye, y solo esas', () => {
    const rutas = rutasConCandado(MODULOS, [
      { id: 'crm', acceso: 'completo' },
      { id: 'automations', acceso: 'solo_lectura' },
      { id: 'authorization', acceso: 'completo' },
    ]);
    expect([...rutas]).toEqual(['/automatizaciones']);
  });

  it('cruza por módulo, no por el prefijo del permiso', () => {
    // `apikeys.manage` y `roles.read` los declara `authorization`: adivinar
    // por el prefijo habría dejado estas dos rutas sin candado.
    const rutas = rutasConCandado(MODULOS, [{ id: 'authorization', acceso: 'solo_lectura' }]);
    expect([...rutas].sort()).toEqual(['/ajustes/api', '/ajustes/roles']);
  });

  it('sin módulos limitados no marca nada', () => {
    expect(rutasConCandado(MODULOS, [{ id: 'crm', acceso: 'completo' }]).size).toBe(0);
    expect(rutasConCandado(MODULOS, []).size).toBe(0);
  });

  it('un módulo sin navegación no rompe nada', () => {
    expect(rutasConCandado([{ id: 'billing' }], [{ id: 'billing', acceso: 'solo_lectura' }]).size).toBe(0);
  });
});
