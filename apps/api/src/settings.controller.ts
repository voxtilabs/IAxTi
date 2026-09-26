import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { withTenant } from '@iaxti/db';
import { getTenantSettings, updateTenantSettings } from '@iaxti/module-organizations';
import { bandejaSettings, cierreSettings, retentionCutoff, scheduleRetentionNotice, setRetentionOverride } from '@iaxti/module-conversations';
import type { BandejaSettings, CierreSettings } from '@iaxti/module-conversations';

type AjustesBandeja = BandejaSettings & CierreSettings;
import { RequireModule, RequirePermission } from './authz/decorators';
import { validar } from './validar';
import type { Actor, WithUser } from './authz/authz.guard';
import { apiPool } from './db';

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

/**
 * El cuerpo de PUT /settings/bandeja (#524).
 *
 * Comprueba UNA cosa: que lleguen ajustes. Los valores no se tipan a propósito
 * —el dominio los normaliza y lo que no calza cae al por-defecto de la spec
 * respondiendo 200, y hay una prueba que lo afirma: `alertaSinDuenoMinutos: -3`
 * vuelve como 10—. Un `z.number()` acá convertiría en 400 lo que hoy se guarda
 * con el defecto, y eso movería el contrato.
 *
 * Los campos van nombrados aunque no validen nada porque `z.object` SACA del
 * cuerpo lo que no declara: la pantalla manda de vuelta el objeto entero que
 * leyó del GET —`horario` y `silencio` incluidos—, así que el campo que
 * faltara acá se perdería en silencio camino al dominio. Y van con
 * `.optional()` uno por uno porque un `z.unknown()` suelto es OBLIGATORIO
 * para zod («expected nonoptional»), y un cuerpo `{}` hoy es válido.
 */
const AjustesDeBandeja = z.object(
  {
    assignmentMode: z.unknown().optional(),
    alertaSinDuenoMinutos: z.unknown().optional(),
    slaPrimeraRespuestaMinutos: z.unknown().optional(),
    horario: z.unknown().optional(),
    silencio: z.unknown().optional(),
    autoResolveDays: z.unknown().optional(),
    archiveAfterMonths: z.unknown().optional(),
  },
  // El mensaje, letra por letra el del `if` que reemplaza: lo lee quien está
  // configurando su bandeja, no quien programa.
  { error: 'No llegó ningún ajuste para guardar.' },
);

/**
 * Ajustes de la bandeja (#38): asignación automática, aviso de "new sin
 * dueño" y SLA de primera respuesta. Solo el ADMIN del tenant
 * (`tenant.settings` según la matriz §23). La forma la valida el dominio
 * (`bandejaSettings`): lo que no calza cae al por-defecto de la spec.
 */
@ApiTags('settings')
@Controller('settings')
@RequireModule('conversations')
export class SettingsController {
  @Get('bandeja')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Ajustes de asignación y SLA de la bandeja' })
  async get(@Req() request: WithUser): Promise<AjustesBandeja> {
    const actor = request.actor as Actor;
    const settings = await withTenant(pool(), actor.tenantId, (c) =>
      getTenantSettings(c, actor.tenantId),
    );
    return { ...bandejaSettings(settings), ...cierreSettings(settings) };
  }

  @Put('bandeja')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Guarda los ajustes de la bandeja' })
  async put(@Req() request: WithUser, @Body() body: unknown): Promise<AjustesBandeja> {
    const actor = request.actor as Actor;
    // `validar` suelto y no `@Cuerpo(...)`: el pipe del decorador convierte el
    // cuerpo ausente en `{}` (`valor ?? {}`), y acá esa diferencia ES el 400.
    // Un PUT sin cuerpo —o con un `Content-Type` que no sea JSON— llega como
    // `undefined`: hoy responde «No llegó ningún ajuste para guardar.» y con el
    // pipe respondería 200 diciendo que guardó, sin haber guardado nada.
    const ajustes = validar(AjustesDeBandeja, body);
    return withTenant(pool(), actor.tenantId, async (c) => {
      const guardados = await getTenantSettings(c, actor.tenantId);
      // Normaliza contra el dominio: valores fuera de rango caen al defecto.
      const limpios = bandejaSettings({ bandeja: { ...bandejaSettings(guardados), ...ajustes } });
      // Cierre/archivo viven en las claves de §39 (auto_resolve_days, …).
      const cierre = cierreSettings({
        auto_resolve_days: ajustes.autoResolveDays ?? cierreSettings(guardados).autoResolveDays,
        archive_after_months:
          ajustes.archiveAfterMonths !== undefined
            ? ajustes.archiveAfterMonths
            : cierreSettings(guardados).archiveAfterMonths,
      });
      await updateTenantSettings(c, actor.tenantId, {
        bandeja: limpios,
        auto_resolve_days: cierre.autoResolveDays,
        archive_after_months: cierre.archiveAfterMonths,
      });
      return { ...limpios, ...cierre };
    });
  }
  @Get('retencion')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'La retención vigente: plan, override y corte' })
  async retencion(@Req() request: WithUser) {
    const actor = request.actor as Actor;
    return withTenant(pool(), actor.tenantId, async (c) => {
      const r = await retentionCutoff(c, actor.tenantId);
      return {
        months: r.months,
        cutoff: r.cutoff ? r.cutoff.toISOString().slice(0, 10) : null,
        deferredUntil: r.deferredUntil ? r.deferredUntil.toISOString().slice(0, 10) : null,
      };
    });
  }

  /**
   * Esta ruta se queda con `@Body()` y sin esquema (#524): no tiene ningún
   * VALIDATION_ERROR que convertir. Lo que no calza sale como
   * RETENTION_INVALID desde el dominio —un `months` que no es número cae en
   * «La retención mínima es de 1 mes.»— y un esquema daría VALIDATION_ERROR en
   * su lugar: otro código para el mismo caso es mover el contrato.
   */
  @Put('retencion')
  @RequirePermission('tenant.settings')
  @ApiOperation({ summary: 'Acorta la retención (jamás más que el plan) — avisa la purga' })
  async setRetencion(@Req() request: WithUser, @Body() body: { months?: number | null }) {
    const actor = request.actor as Actor;
    return withTenant(pool(), actor.tenantId, async (c) => {
      try {
        await setRetentionOverride(c, { tenantId: actor.tenantId, months: body?.months ?? null });
      } catch (err) {
        throw new BadRequestException({ code: 'RETENTION_INVALID', message: (err as Error).message });
      }
      // La cantidad EXACTA que capturaría el corte nuevo, con la purga
      // diferida 30 días (§39) — el aviso viaja en la respuesta.
      const aviso = await scheduleRetentionNotice(c, actor.tenantId);
      return {
        saved: true,
        purgeNotice: aviso
          ? { count: aviso.affected, firstPurgeAt: aviso.firstPurgeAt.toISOString().slice(0, 10) }
          : null,
      };
    });
  }

}
