import type { SupresionEnModulos } from '@iaxti/module-crm';
import { suprimirDatosDelTitular as agents } from '@iaxti/module-agents';
import { datosParaSuprimirTitular, suprimirDatosDelTitular as conversations } from '@iaxti/module-conversations';
import { suprimirDatosDelTitular as integrations } from '@iaxti/module-integrations';
import { suprimirDatosDelTitular as payments } from '@iaxti/module-payments';
import { suprimirDatosDelTitular as analytics } from '@iaxti/module-analytics';

// Composición sin ciclos entre módulos. La supresión legal alcanza datos
// persistidos incluso si una función comercial está apagada (SPEC §39).
export const supresionEnModulos: SupresionEnModulos = {
  datos: datosParaSuprimirTitular,
  agents,
  conversations,
  integrations,
  payments,
  analytics,
};
