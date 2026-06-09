import { randomUUID } from 'crypto'
import { eq, and, desc, sql } from 'drizzle-orm'
import { db } from '../db'
import { ofertaMercado, puja, plantillaFantasy, miembroLiga, transferencia } from '../db/schema'

export async function cerrarOfertaLogic(ofertaId: string) {
  const oferta = await db.query.ofertaMercado.findFirst({
    where: eq(ofertaMercado.id, ofertaId),
    with: { pujas: { orderBy: desc(puja.cantidad), limit: 1 } },
  })

  if (!oferta || oferta.estado !== 'ACTIVA') return null

  return db.transaction(async tx => {
    const mejorPuja = oferta.pujas[0]

    if (!mejorPuja) {
      await tx.update(ofertaMercado).set({ estado: 'CANCELADA' }).where(eq(ofertaMercado.id, ofertaId))
      return { resultado: 'CANCELADA' as const }
    }

    await tx.update(ofertaMercado).set({ estado: 'VENDIDA' }).where(eq(ofertaMercado.id, ofertaId))

    if (oferta.vendedorId) {
      await tx.delete(plantillaFantasy).where(
        and(eq(plantillaFantasy.ligaId, oferta.ligaId), eq(plantillaFantasy.jugadorId, oferta.jugadorId))
      )
      await tx.update(miembroLiga)
        .set({ presupuestoRestante: sql`${miembroLiga.presupuestoRestante} + ${mejorPuja.cantidad}` })
        .where(eq(miembroLiga.id, oferta.vendedorId))
    }

    await tx.insert(plantillaFantasy).values({
      id: randomUUID(), ligaId: oferta.ligaId, miembroLigaId: mejorPuja.miembroLigaId,
      jugadorId: oferta.jugadorId, precioCompra: mejorPuja.cantidad, creadoEn: new Date(),
    })
    await tx.update(miembroLiga)
      .set({ presupuestoRestante: sql`${miembroLiga.presupuestoRestante} - ${mejorPuja.cantidad}` })
      .where(eq(miembroLiga.id, mejorPuja.miembroLigaId))
    await tx.insert(transferencia).values({
      id: randomUUID(), jugadorId: oferta.jugadorId, ligaId: oferta.ligaId,
      vendedorId: oferta.vendedorId ?? null, compradorId: mejorPuja.miembroLigaId,
      ofertaId, precio: mejorPuja.cantidad, fecha: new Date(),
    })

    return { resultado: 'VENDIDA' as const, compradorId: mejorPuja.miembroLigaId, precio: mejorPuja.cantidad }
  })
}
