import { prisma } from '../prismaClient'

// Cierra una oferta (por caducidad o por acción del vendedor).
// Funciona tanto para ofertas de usuario (vendedorId != null) como del sistema (vendedorId = null).
export async function cerrarOfertaLogic(ofertaId: string) {
  const oferta = await prisma.ofertaMercado.findUnique({
    where: { id: ofertaId },
    include: { pujas: { orderBy: { cantidad: 'desc' }, take: 1 } },
  })

  if (!oferta || oferta.estado !== 'ACTIVA') return null

  return prisma.$transaction(async tx => {
    const mejorPuja = oferta.pujas[0]

    if (!mejorPuja) {
      await tx.ofertaMercado.update({ where: { id: ofertaId }, data: { estado: 'CANCELADA' } })
      return { resultado: 'CANCELADA' as const }
    }

    await tx.ofertaMercado.update({ where: { id: ofertaId }, data: { estado: 'VENDIDA' } })

    // Oferta de usuario: quitarle el jugador y devolverle el dinero
    if (oferta.vendedorId) {
      await tx.plantillaFantasy.delete({
        where: { ligaId_jugadorId: { ligaId: oferta.ligaId, jugadorId: oferta.jugadorId } },
      })
      await tx.miembroLiga.update({
        where: { id: oferta.vendedorId },
        data: { presupuestoRestante: { increment: mejorPuja.cantidad } },
      })
    }
    // Oferta del sistema: el jugador no está en ninguna plantilla, nada que quitar

    // Añadir jugador al comprador y descontarle el dinero
    await tx.plantillaFantasy.create({
      data: {
        ligaId: oferta.ligaId,
        miembroLigaId: mejorPuja.miembroLigaId,
        jugadorId: oferta.jugadorId,
        precioCompra: mejorPuja.cantidad,
      },
    })
    await tx.miembroLiga.update({
      where: { id: mejorPuja.miembroLigaId },
      data: { presupuestoRestante: { decrement: mejorPuja.cantidad } },
    })

    await tx.transferencia.create({
      data: {
        jugadorId: oferta.jugadorId,
        ligaId: oferta.ligaId,
        vendedorId: oferta.vendedorId ?? null,
        compradorId: mejorPuja.miembroLigaId,
        ofertaId,
        precio: mejorPuja.cantidad,
      },
    })

    return { resultado: 'VENDIDA' as const, compradorId: mejorPuja.miembroLigaId, precio: mejorPuja.cantidad }
  })
}
