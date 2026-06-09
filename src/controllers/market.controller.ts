import { randomUUID } from 'crypto'
import { Response } from 'express'
import { eq, and, count, desc, inArray } from 'drizzle-orm'
import { db } from '../db'
import { ofertaMercado, puja, miembroLiga, plantillaFantasy, jugadorEquipo, transferencia } from '../db/schema'
import { AuthRequest } from '../middleware/auth.middleware'
import { cerrarOfertaLogic } from '../lib/cerrarOfertaLogic'

async function getMiembro(ligaId: string, usuarioId: string) {
  return db.query.miembroLiga.findFirst({
    where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)),
  })
}

export const getOfertasLiga = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const ofertas = await db.query.ofertaMercado.findMany({
      where:   and(eq(ofertaMercado.ligaId, ligaId), eq(ofertaMercado.estado, 'ACTIVA')),
      orderBy: desc(ofertaMercado.creadoEn),
      with: {
        jugador: {
          with: {
            historialEquipos: {
              where:   eq(jugadorEquipo.activo, true),
              limit:   1,
              with:    { equipo: true },
            },
          },
        },
        vendedor: { with: { usuario: { columns: { username: true } } } },
        pujas: {
          where:   eq(puja.miembroLigaId, miembro.id),
          columns: { cantidad: true },
        },
      },
    })

    const ofertaIds   = ofertas.map(o => o.id)
    const pujaCounts  = ofertaIds.length > 0
      ? await db.select({ ofertaId: puja.ofertaMercadoId, total: count() })
          .from(puja).where(inArray(puja.ofertaMercadoId, ofertaIds)).groupBy(puja.ofertaMercadoId)
      : []
    const countMap = new Map(pujaCounts.map(c => [c.ofertaId, c.total]))

    const respuesta = ofertas.map(({ pujas: misPujas, ...o }) => ({
      ...o,
      numPujas: countMap.get(o.id) ?? 0,
      miPuja:   misPujas[0]?.cantidad ?? null,
    }))
    res.json(respuesta)
  } catch {
    res.status(500).json({ error: 'Error al obtener el mercado' })
  }
}

export const crearOferta = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!
  const { jugadorId, precioMinimo, diasCaducidad } = req.body

  if (!jugadorId || precioMinimo == null) { res.status(400).json({ error: 'jugadorId y precioMinimo son obligatorios' }); return }
  if (precioMinimo <= 0)                  { res.status(400).json({ error: 'precioMinimo debe ser mayor que 0' }); return }
  if (diasCaducidad != null && (!Number.isInteger(diasCaducidad) || diasCaducidad < 1 || diasCaducidad > 90)) {
    res.status(400).json({ error: 'diasCaducidad debe ser un número entero entre 1 y 90' }); return
  }

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const [jugadorEnEquipo] = await db.select().from(plantillaFantasy)
      .where(and(eq(plantillaFantasy.ligaId, ligaId), eq(plantillaFantasy.jugadorId, jugadorId))).limit(1)
    if (!jugadorEnEquipo || jugadorEnEquipo.miembroLigaId !== miembro.id) {
      res.status(403).json({ error: 'No tienes este jugador en tu equipo' }); return
    }

    const [ofertaActiva] = await db.select({ id: ofertaMercado.id }).from(ofertaMercado).where(
      and(eq(ofertaMercado.ligaId, ligaId), eq(ofertaMercado.jugadorId, jugadorId),
          eq(ofertaMercado.vendedorId, miembro.id), eq(ofertaMercado.estado, 'ACTIVA'))
    ).limit(1)
    if (ofertaActiva) { res.status(409).json({ error: 'Ya tienes este jugador en el mercado' }); return }

    const fechaCaducidad = diasCaducidad ? new Date(Date.now() + diasCaducidad * 24 * 60 * 60 * 1000) : null
    const id = randomUUID()
    await db.insert(ofertaMercado).values({ id, ligaId, jugadorId, vendedorId: miembro.id, precioMinimo, fechaCaducidad, estado: 'ACTIVA', creadoEn: new Date() })
    const oferta = await db.query.ofertaMercado.findFirst({ where: eq(ofertaMercado.id, id), with: { jugador: true } })
    res.status(201).json(oferta)
  } catch {
    res.status(500).json({ error: 'Error al crear la oferta' })
  }
}

export const pujar = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const ofertaId  = req.params.ofertaId as string
  const usuarioId = req.usuarioId!
  const { cantidad } = req.body

  if (cantidad == null || cantidad <= 0) { res.status(400).json({ error: 'cantidad debe ser mayor que 0' }); return }

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const [oferta] = await db.select().from(ofertaMercado).where(eq(ofertaMercado.id, ofertaId)).limit(1)
    if (!oferta || oferta.ligaId !== ligaId)    { res.status(404).json({ error: 'Oferta no encontrada' }); return }
    if (oferta.estado !== 'ACTIVA')             { res.status(409).json({ error: 'La oferta ya no está activa' }); return }
    if (oferta.vendedorId === miembro.id)       { res.status(400).json({ error: 'No puedes pujar por tu propio jugador' }); return }
    if (cantidad < oferta.precioMinimo)         { res.status(400).json({ error: `La puja mínima es ${oferta.precioMinimo}` }); return }
    if (cantidad > miembro.presupuestoRestante) { res.status(400).json({ error: 'Presupuesto insuficiente' }); return }

    const [pujaActual] = await db.select().from(puja)
      .where(and(eq(puja.ofertaMercadoId, ofertaId), eq(puja.miembroLigaId, miembro.id))).limit(1)
    if (pujaActual && cantidad <= pujaActual.cantidad) {
      res.status(400).json({ error: `Tu puja debe superar tu oferta actual (${pujaActual.cantidad})` }); return
    }

    await db.insert(puja)
      .values({ id: randomUUID(), ofertaMercadoId: ofertaId, miembroLigaId: miembro.id, cantidad, creadoEn: new Date() })
      .onDuplicateKeyUpdate({ set: { cantidad } })

    const [result] = await db.select().from(puja)
      .where(and(eq(puja.ofertaMercadoId, ofertaId), eq(puja.miembroLigaId, miembro.id))).limit(1)
    res.json(result)
  } catch {
    res.status(500).json({ error: 'Error al registrar la puja' })
  }
}

export const cerrarOferta = async (req: AuthRequest, res: Response) => {
  const ligaId   = req.params.ligaId as string
  const ofertaId = req.params.ofertaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const oferta = await db.query.ofertaMercado.findFirst({
      where: eq(ofertaMercado.id, ofertaId),
      with:  { pujas: { orderBy: desc(puja.cantidad), limit: 1 } },
    })
    if (!oferta || oferta.ligaId !== ligaId) { res.status(404).json({ error: 'Oferta no encontrada' }); return }
    if (oferta.estado !== 'ACTIVA')           { res.status(409).json({ error: 'La oferta ya no está activa' }); return }
    if (oferta.vendedorId !== miembro.id)     { res.status(403).json({ error: 'Solo el vendedor puede cerrar esta oferta' }); return }

    const resultado = await cerrarOfertaLogic(ofertaId)
    if (resultado?.resultado === 'CANCELADA') {
      res.json({ mensaje: 'Oferta cancelada: ningún equipo realizó pujas' }); return
    }
    res.json({ mensaje: 'Oferta cerrada. Transferencia completada.' })
  } catch {
    res.status(500).json({ error: 'Error al cerrar la oferta' })
  }
}

export const cancelarOferta = async (req: AuthRequest, res: Response) => {
  const ligaId   = req.params.ligaId as string
  const ofertaId = req.params.ofertaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const [oferta] = await db.select().from(ofertaMercado).where(eq(ofertaMercado.id, ofertaId)).limit(1)
    if (!oferta || oferta.ligaId !== ligaId) { res.status(404).json({ error: 'Oferta no encontrada' }); return }
    if (oferta.estado !== 'ACTIVA')           { res.status(409).json({ error: 'La oferta ya no está activa' }); return }
    if (oferta.vendedorId !== miembro.id)     { res.status(403).json({ error: 'Solo el vendedor puede cancelar esta oferta' }); return }

    await db.update(ofertaMercado).set({ estado: 'CANCELADA' }).where(eq(ofertaMercado.id, ofertaId))
    res.json({ mensaje: 'Oferta cancelada' })
  } catch {
    res.status(500).json({ error: 'Error al cancelar la oferta' })
  }
}

export const getTransferencias = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const transferencias = await db.query.transferencia.findMany({
      where:   eq(transferencia.ligaId, ligaId),
      orderBy: desc(transferencia.fecha),
      with: {
        jugador: {
          with: {
            historialEquipos: { where: eq(jugadorEquipo.activo, true), limit: 1, with: { equipo: true } },
          },
        },
        vendedor:  { with: { usuario: { columns: { username: true } } } },
        comprador: { with: { usuario: { columns: { username: true } } } },
      },
    })
    res.json(transferencias)
  } catch {
    res.status(500).json({ error: 'Error al obtener el historial' })
  }
}
