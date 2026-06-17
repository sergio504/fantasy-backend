import { randomUUID } from 'crypto'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db'
import { ofertaMercado, puja, plantillaFantasy, miembroLiga, transferencia, jugador } from '../db/schema'
import { registrarMovimientoSaldo, registrarCambioClausula } from './historial'

export async function cerrarOfertaLogic(ofertaId: string) {
  const [oferta] = await db.select().from(ofertaMercado).where(eq(ofertaMercado.id, ofertaId)).limit(1)

  if (!oferta || oferta.estado !== 'ACTIVA') return null

  const [mejorPuja] = await db.select().from(puja)
    .where(eq(puja.ofertaMercadoId, ofertaId))
    .orderBy(desc(puja.cantidad))
    .limit(1)

  return db.transaction(async tx => {

    if (!mejorPuja) {
      await tx.update(ofertaMercado).set({ estado: 'CANCELADA' }).where(eq(ofertaMercado.id, ofertaId))
      return { resultado: 'CANCELADA' as const }
    }

    // Fetch current budgets + clausula for history before any mutation
    const [compradorRow] = await tx.select({ presupuestoRestante: miembroLiga.presupuestoRestante })
      .from(miembroLiga).where(eq(miembroLiga.id, mejorPuja.miembroLigaId)).limit(1)
    const [vendedorRow] = oferta.vendedorId
      ? await tx.select({ presupuestoRestante: miembroLiga.presupuestoRestante })
          .from(miembroLiga).where(eq(miembroLiga.id, oferta.vendedorId)).limit(1)
      : [null]
    const [jugadorRow] = await tx.select({ nombre: jugador.nombre })
      .from(jugador).where(eq(jugador.id, oferta.jugadorId)).limit(1)
    const [plantillaVendedor] = oferta.vendedorId
      ? await tx.select({ clausula: plantillaFantasy.clausula })
          .from(plantillaFantasy)
          .where(and(eq(plantillaFantasy.ligaId, oferta.ligaId), eq(plantillaFantasy.jugadorId, oferta.jugadorId)))
          .limit(1)
      : [null]

    const nombreJugador = jugadorRow?.nombre ?? 'Jugador'

    await tx.update(ofertaMercado).set({ estado: 'VENDIDA' }).where(eq(ofertaMercado.id, ofertaId))

    if (oferta.vendedorId) {
      await tx.delete(plantillaFantasy).where(
        and(eq(plantillaFantasy.ligaId, oferta.ligaId), eq(plantillaFantasy.jugadorId, oferta.jugadorId))
      )
      await tx.update(miembroLiga)
        .set({ presupuestoRestante: (vendedorRow!.presupuestoRestante + mejorPuja.cantidad) })
        .where(eq(miembroLiga.id, oferta.vendedorId))
    }

    const nuevaClausula = mejorPuja.cantidad * 2
    await tx.insert(plantillaFantasy).values({
      id: randomUUID(), ligaId: oferta.ligaId, miembroLigaId: mejorPuja.miembroLigaId,
      jugadorId: oferta.jugadorId, precioCompra: mejorPuja.cantidad,
      clausula: nuevaClausula, jornadasBloqueo: 3,
      creadoEn: new Date(),
    })
    await tx.update(miembroLiga)
      .set({ presupuestoRestante: (compradorRow!.presupuestoRestante - mejorPuja.cantidad) })
      .where(eq(miembroLiga.id, mejorPuja.miembroLigaId))
    await tx.insert(transferencia).values({
      id: randomUUID(), jugadorId: oferta.jugadorId, ligaId: oferta.ligaId,
      vendedorId: oferta.vendedorId ?? null, compradorId: mejorPuja.miembroLigaId,
      ofertaId, precio: mejorPuja.cantidad, fecha: new Date(),
    })

    // Historial saldo comprador
    await registrarMovimientoSaldo(tx, {
      miembroLigaId:   mejorPuja.miembroLigaId,
      ligaId:          oferta.ligaId,
      concepto:        'COMPRA_MERCADO',
      importe:         -mejorPuja.cantidad,
      saldoResultante: compradorRow!.presupuestoRestante - mejorPuja.cantidad,
      descripcion:     `Compra de ${nombreJugador}`,
      jugadorId:       oferta.jugadorId,
    })

    // Historial saldo vendedor
    if (oferta.vendedorId && vendedorRow) {
      await registrarMovimientoSaldo(tx, {
        miembroLigaId:   oferta.vendedorId,
        ligaId:          oferta.ligaId,
        concepto:        'VENTA_MERCADO',
        importe:         mejorPuja.cantidad,
        saldoResultante: vendedorRow.presupuestoRestante + mejorPuja.cantidad,
        descripcion:     `Venta de ${nombreJugador}`,
        jugadorId:       oferta.jugadorId,
      })
    }

    // Historial cláusula (nuevo propietario)
    await registrarCambioClausula(tx, {
      jugadorId:        oferta.jugadorId,
      ligaId:           oferta.ligaId,
      miembroLigaId:    mejorPuja.miembroLigaId,
      clausulaAnterior: plantillaVendedor?.clausula ?? 0,
      clausulaNueva:    nuevaClausula,
      motivo:           'ADQUISICION',
    })

    return { resultado: 'VENDIDA' as const, compradorId: mejorPuja.miembroLigaId, precio: mejorPuja.cantidad }
  })
}
