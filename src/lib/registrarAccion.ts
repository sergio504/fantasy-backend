import { randomUUID } from 'crypto'
import { db } from '../db'
import { historialAdmin, TipoAccionAdmin } from '../db/schema'

export async function registrarAccion(
  adminId: string,
  accion: TipoAccionAdmin,
  entidad: string,
  entidadId: string,
  datosDespues: object,
  datosAntes?: object
) {
  await db.insert(historialAdmin).values({
    id:           randomUUID(),
    adminId,
    accion,
    entidad,
    entidadId,
    datosDespues,
    datosAntes:   datosAntes ?? null,
    creadoEn:     new Date(),
  })
}
