import { TipoAccionAdmin } from '@prisma/client'
import { prisma } from '../prismaClient'

export async function registrarAccion(
  adminId: string,
  accion: TipoAccionAdmin,
  entidad: string,
  entidadId: string,
  datosDespues: object,
  datosAntes?: object
) {
  await prisma.historialAdmin.create({
    data: {
      adminId,
      accion,
      entidad,
      entidadId,
      datosDespues,
      datosAntes: datosAntes ?? undefined,
    },
  })
}
