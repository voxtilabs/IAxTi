import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { withTenant } from '@iaxti/db';
import {
  searchAudit,
  searchAuditGlobal,
  signExport,
  verifyChain,
  type AuditFilter,
} from '@iaxti/module-audit';
import { RequirePermission } from './authz/decorators';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

// El explorador de auditoría (#72, SPEC §13). Dos puertas, un solo motor: el
// ADMIN ve SU libro (RLS lo acota) y el SuperAdmin ve todos. La exportación
// sale firmada para que un auditor pueda verificarla sin creernos nada.

function pool() {
  const p = apiPool();
  if (!p) {
    throw new ServiceUnavailableException({
      code: 'DB_NOT_CONFIGURED',
      message: 'El servidor aún no tiene base de datos configurada. Intenta más tarde.',
    });
  }
  return p;
}

function actorOf(request: WithUser): Actor {
  return request.actor as Actor;
}

/** Una fecha inválida en un filtro no puede pasar como "sin filtro". */
function fecha(valor: string | undefined, campo: string): Date | undefined {
  if (!valor) return undefined;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({
      code: 'FILTER_INVALID',
      message: `La fecha de "${campo}" no se entiende. Usa AAAA-MM-DD.`,
    });
  }
  return d;
}

type Consulta = Record<string, string | undefined>;

function filtrosDe(q: Consulta): AuditFilter {
  return {
    actor: q.actor || undefined,
    actorKind: (q.actorKind as AuditFilter['actorKind']) || undefined,
    action: q.action || undefined,
    resource: q.resource || undefined,
    ip: q.ip || undefined,
    result: q.result || undefined,
    from: fecha(q.from, 'desde'),
    to: fecha(q.to, 'hasta'),
    limit: q.limit ? Number(q.limit) : undefined,
  };
}

/**
 * Los filtros del libro, DECLARADOS (#546).
 *
 * `@Query() q: Consulta` sin nombre no publica nada en el OpenAPI: las cuatro
 * rutas de auditoría salían con `"parameters": []`. Eso tiene dos costos
 * distintos y el segundo es el caro:
 *
 *  - Quien lea `/docs` no sabe por qué puede filtrar el libro de su negocio.
 *  - El catálogo del Agente General (#492) se genera del OpenAPI, así que la
 *    herramienta de auditoría llegaba al modelo SIN argumentos. El agente la
 *    llama, el filtro se le cae en silencio, y contesta con las últimas
 *    entradas de todo el libro como si fueran las que se le pidieron. Sobre
 *    auditoría, que es donde alguien pregunta «quién cambió esto».
 *
 * Se declaran acá una vez y se aplican a las cuatro rutas con un decorador
 * compuesto, en vez de repetir diez `@ApiQuery` cuatro veces — repetirlos es
 * garantizar que las cuatro listas se separen.
 */
const FILTROS_DEL_LIBRO = [
  { name: 'actor', description: 'Quién lo hizo: id de usuario o de API key.' },
  { name: 'actorKind', description: 'user, apikey o system.', enum: ['user', 'apikey', 'system'] },
  { name: 'action', description: 'La acción, como `crm.contact.update`.' },
  { name: 'resource', description: 'El tipo de objeto: contact, deal, payment_link…' },
  { name: 'ip', description: 'Desde qué IP.' },
  { name: 'result', description: 'ok o denied.', enum: ['ok', 'denied'] },
  { name: 'from', description: 'Desde cuándo, AAAA-MM-DD.' },
  { name: 'to', description: 'Hasta cuándo, AAAA-MM-DD (inclusive).' },
  { name: 'limit', description: 'Cuántas entradas, hasta 100.', schema: { type: 'integer', minimum: 1, maximum: 100 } },
] as const;

/** Los diez filtros en una línea, para no repetirlos en cada ruta. */
function ConFiltrosDelLibro(): MethodDecorator {
  const decoradores = FILTROS_DEL_LIBRO.map((f) =>
    ApiQuery({ required: false, type: String, ...f } as Parameters<typeof ApiQuery>[0]),
  );
  return (target, key, descriptor) => {
    for (const d of decoradores) d(target, key, descriptor);
    return descriptor;
  };
}

/** El `format` es solo de las rutas de exportación. */
function ConFormato(): MethodDecorator {
  return ApiQuery({
    name: 'format',
    required: false,
    enum: ['csv', 'json'],
    description: 'csv por omisión.',
  }) as MethodDecorator;
}

/** El tenant del libro global llega en la consulta: puede ser cualquier cosa. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatoDe(valor: string | undefined): 'csv' | 'json' {
  if (valor && valor !== 'csv' && valor !== 'json') {
    throw new BadRequestException({
      code: 'FORMAT_INVALID',
      message: 'El export es csv o json.',
    });
  }
  return (valor as 'csv' | 'json') ?? 'csv';
}

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  @Get()
  @RequirePermission('audit.read')
  @ApiOperation({ summary: 'El libro del propio tenant, con filtros' })
  @ConFiltrosDelLibro()
  async search(@Req() request: WithUser, @Query() q: Consulta) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => searchAudit(c, filtrosDe(q)));
  }

  @Post('verify')
  @RequirePermission('audit.read')
  @ApiOperation({ summary: 'Verifica la cadena de hash del propio tenant' })
  async verify(@Req() request: WithUser) {
    const actor = actorOf(request);
    return withTenant(pool(), actor.tenantId, (c) => verifyChain(c, actor.tenantId));
  }

  @Get('export')
  // Leer el libro y LLEVÁRSELO no son lo mismo: un export es un archivo que
  // sale del sistema y sigue existiendo después. Por eso el catálogo tiene
  // `audit.export` aparte — y hasta ahora no lo usaba nadie.
  @RequirePermission('audit.export')
  @ApiOperation({ summary: 'Exporta el libro del tenant, firmado' })
  @ConFiltrosDelLibro()
  @ConFormato()
  async export(@Req() request: WithUser, @Query() q: Consulta) {
    const actor = actorOf(request);
    const formato = formatoDe(q.format);
    const filas = await withTenant(pool(), actor.tenantId, (c) =>
      searchAudit(c, { ...filtrosDe(q), limit: Math.min(Number(q.limit ?? 1000), 1000) }),
    );
    return signExport(filas, formato);
  }
}

@ApiTags('platform')
@Controller('platform/audit')
export class PlatformAuditController {
  @Get()
  @RequirePermission('platform.audit')
  @ApiOperation({ summary: 'El libro de TODOS los tenants, con filtros' })
  @ConFiltrosDelLibro()
  async search(@Query() q: Consulta) {
    const client = await pool().connect();
    try {
      return await searchAuditGlobal(client, { ...filtrosDe(q), tenantId: q.tenantId || undefined });
    } finally {
      client.release();
    }
  }

  /**
   * Verificar la cadena de UN tenant, con ese tenant en contexto (#370).
   *
   * Corría con una conexión suelta del pool, y `audit_log` tiene RLS FORCE.
   * Con el rol de desarrollo —superusuario— Postgres ni mira las políticas y
   * parecía funcionar; con un rol que las respete, que es lo que producción
   * exige, la política evalúa `tenant_id = NULL`, `verifyChain` recorre cero
   * filas y devuelve **`{ valid: true, entries: 0 }`**.
   *
   * Ese es el peor resultado posible de los tres. Un libro append-only cuya
   * verificación contesta "válido" sin haber podido leer una sola fila no es
   * una verificación débil: es una garantía que nadie comprobó, entregada
   * justo a quien vino a comprobarla. Y no hay nada en la respuesta que lo
   * delate — un libro vacío y un libro ilegible se ven idénticos.
   *
   * Acá SÍ hay tenant (llega en la consulta), así que no hace falta ninguna
   * puerta especial: se entra por `withTenant` como en todo el resto.
   */
  @Post('verify')
  @RequirePermission('platform.audit')
  @ApiOperation({ summary: 'Verifica la cadena de hash de un tenant cualquiera' })
  async verify(@Query('tenantId') tenantId: string, @Body() _body: unknown) {
    if (!tenantId) {
      throw new BadRequestException({
        code: 'TENANT_REQUIRED',
        message: 'La cadena se verifica de a un tenant: dime cuál.',
      });
    }
    // Un tenant que no existe tiene el mismo libro que un tenant ilegible:
    // ninguno. Contestar "válido" ahí es la misma mentira con otra causa, así
    // que se dice que no existe. `tenants` no tiene RLS a propósito: es el
    // registro de quiénes existen (packages/db/src/tenant.ts).
    //
    // El id llega de la consulta, así que puede no ser un uuid; un `= $1` con
    // cualquier texto revienta con el error crudo de Postgres. Un id mal
    // escrito es un negocio que no encontramos, no un 500.
    const existe = UUID.test(tenantId)
      ? await pool().query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])
      : { rowCount: 0 };
    if ((existe.rowCount ?? 0) === 0) {
      throw new NotFoundException({
        code: 'TENANT_NOT_FOUND',
        message: 'No encontramos ese negocio. Revisa el id antes de verificar su libro.',
      });
    }
    return withTenant(pool(), tenantId, (c) => verifyChain(c, tenantId));
  }

  @Get('export')
  @RequirePermission('platform.audit')
  @ApiOperation({ summary: 'Exporta el libro global (o el de un tenant), firmado' })
  @ConFiltrosDelLibro()
  @ConFormato()
  async export(@Query() q: Consulta) {
    const formato = formatoDe(q.format);
    const client = await pool().connect();
    try {
      const filas = await searchAuditGlobal(client, {
        ...filtrosDe(q),
        tenantId: q.tenantId || undefined,
        limit: Math.min(Number(q.limit ?? 1000), 1000),
      });
      return signExport(filas, formato);
    } finally {
      client.release();
    }
  }
}
