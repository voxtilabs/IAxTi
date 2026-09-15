import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
  async search(@Query() q: Consulta) {
    const client = await pool().connect();
    try {
      return await searchAuditGlobal(client, { ...filtrosDe(q), tenantId: q.tenantId || undefined });
    } finally {
      client.release();
    }
  }

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
    const client = await pool().connect();
    try {
      return await verifyChain(client, tenantId);
    } finally {
      client.release();
    }
  }

  @Get('export')
  @RequirePermission('platform.audit')
  @ApiOperation({ summary: 'Exporta el libro global (o el de un tenant), firmado' })
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
