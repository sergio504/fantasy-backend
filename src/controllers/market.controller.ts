import { randomUUID } from 'crypto'
import { Response } from 'express'
import { eq, and, count, desc, inArray } from 'drizzle-orm'
import { db } from '../db'
import { ofertaMercado, puja, miembroLiga, plantillaFantasy, titularLiga, jugadorEquipo, equipo, jugador, usuario, transferencia } from '../db/schema'
import { AuthRequest } from '../middleware/auth.middleware'
import { cerrarOfertaLogic } from '../lib/cerrarOfertaLogic'
import { registrarMovimientoSaldo } from '../lib/historial'

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

    const ofertasRaw = await db.select().from(ofertaMercado)
      .where(and(eq(ofertaMercado.ligaId, ligaId), eq(ofertaMercado.estado, 'ACTIVA')))
      .orderBy(desc(ofertaMercado.creadoEn))

    const ofertaIds   = ofertasRaw.map(o => o.id)
    const jugadorIds  = ofertasRaw.map(o => o.jugadorId)
    const vendedorIds = [...new Set(ofertasRaw.map(o => o.vendedorId).filter((v): v is string => v !== null))]

    const [jugadoresRaw, vendedoresRaw] = await Promise.all([
      jugadorIds.length > 0 ? db.select().from(jugador).where(inArray(jugador.id, jugadorIds)) : Promise.resolve([]),
      vendedorIds.length > 0
        ? db.select({ mlId: miembroLiga.id, uUsername: usuario.username })
            .from(miembroLiga).innerJoin(usuario, eq(usuario.id, miembroLiga.usuarioId))
            .where(inArray(miembroLiga.id, vendedorIds))
        : Promise.resolve([]),
    ])
    const jugadorMapOferta  = new Map(jugadoresRaw.map(j => [j.id, j]))
    const vendedorMapOferta = new Map(vendedoresRaw.map(v => [v.mlId, { id: v.mlId, usuario: { username: v.uUsername } }]))

    const [equiposActivos, misPujas, pujaCounts] = await Promise.all([
      jugadorIds.length > 0
        ? db.select({
              jeJugadorId: jugadorEquipo.jugadorId, jeId: jugadorEquipo.id,
              jeEquipoId: jugadorEquipo.equipoId, jeDesde: jugadorEquipo.desde,
              jeHasta: jugadorEquipo.hasta, jeActivo: jugadorEquipo.activo, jeCreadoEn: jugadorEquipo.creadoEn,
              eId: equipo.id, eNombre: equipo.nombre, eDivision: equipo.division, eCreadoEn: equipo.creadoEn,
            })
            .from(jugadorEquipo)
            .innerJoin(equipo, eq(equipo.id, jugadorEquipo.equipoId))
            .where(and(eq(jugadorEquipo.activo, true), inArray(jugadorEquipo.jugadorId, jugadorIds)))
        : Promise.resolve([]),
      ofertaIds.length > 0
        ? db.select({ ofertaMercadoId: puja.ofertaMercadoId, cantidad: puja.cantidad })
            .from(puja).where(and(eq(puja.miembroLigaId, miembro.id), inArray(puja.ofertaMercadoId, ofertaIds)))
        : Promise.resolve([]),
      ofertaIds.length > 0
        ? db.select({ ofertaId: puja.ofertaMercadoId, total: count() })
            .from(puja).where(inArray(puja.ofertaMercadoId, ofertaIds)).groupBy(puja.ofertaMercadoId)
        : Promise.resolve([]),
    ])

    const histMap  = new Map(equiposActivos.map(r => [r.jeJugadorId, {
      id: r.jeId, jugadorId: r.jeJugadorId, equipoId: r.jeEquipoId,
      desde: r.jeDesde, hasta: r.jeHasta, activo: r.jeActivo, creadoEn: r.jeCreadoEn,
      equipo: { id: r.eId, nombre: r.eNombre, division: r.eDivision, creadoEn: r.eCreadoEn },
    }]))
    const pujaMap  = new Map(misPujas.map(p => [p.ofertaMercadoId, p.cantidad]))
    const countMap = new Map(pujaCounts.map(c => [c.ofertaId, c.total]))

    res.json(ofertasRaw.map(o => {
      const j = jugadorMapOferta.get(o.jugadorId) ?? null
      return {
        ...o,
        jugador:  j ? { ...j, historialEquipos: histMap.has(j.id) ? [histMap.get(j.id)!] : [] } : null,
        vendedor: o.vendedorId ? (vendedorMapOferta.get(o.vendedorId) ?? null) : null,
        numPujas: countMap.get(o.id) ?? 0,
        miPuja:   pujaMap.get(o.id) ?? null,
      }
    }))
  } catch (e) {
    console.error('[getOfertasLiga]', e)
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

    const [esTitular] = await db.select({ id: titularLiga.jugadorId }).from(titularLiga)
      .where(and(eq(titularLiga.miembroLigaId, miembro.id), eq(titularLiga.jugadorId, jugadorId))).limit(1)
    if (esTitular) { res.status(400).json({ error: 'No puedes vender a un titular. Ponlo como suplente primero.' }); return }

    const [ofertaActiva] = await db.select({ id: ofertaMercado.id }).from(ofertaMercado).where(
      and(eq(ofertaMercado.ligaId, ligaId), eq(ofertaMercado.jugadorId, jugadorId),
          eq(ofertaMercado.vendedorId, miembro.id), eq(ofertaMercado.estado, 'ACTIVA'))
    ).limit(1)
    if (ofertaActiva) { res.status(409).json({ error: 'Ya tienes este jugador en el mercado' }); return }

    const fechaCaducidad = diasCaducidad ? new Date(Date.now() + diasCaducidad * 24 * 60 * 60 * 1000) : null
    const id = randomUUID()
    await db.insert(ofertaMercado).values({ id, ligaId, jugadorId, vendedorId: miembro.id, precioMinimo, fechaCaducidad, estado: 'ACTIVA', creadoEn: new Date() })
    const [[ofertaData], [jugadorData]] = await Promise.all([
      db.select().from(ofertaMercado).where(eq(ofertaMercado.id, id)).limit(1),
      db.select().from(jugador).where(eq(jugador.id, jugadorId)).limit(1),
    ])
    res.status(201).json({ ...ofertaData, jugador: jugadorData })
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

export const retirarPuja = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const ofertaId  = req.params.ofertaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const [oferta] = await db.select({ estado: ofertaMercado.estado }).from(ofertaMercado)
      .where(and(eq(ofertaMercado.id, ofertaId), eq(ofertaMercado.ligaId, ligaId))).limit(1)
    if (!oferta)                    { res.status(404).json({ error: 'Oferta no encontrada' }); return }
    if (oferta.estado !== 'ACTIVA') { res.status(409).json({ error: 'La oferta ya no está activa' }); return }

    const deleted = await db.delete(puja)
      .where(and(eq(puja.ofertaMercadoId, ofertaId), eq(puja.miembroLigaId, miembro.id)))
    if ((deleted[0] as any).affectedRows === 0) {
      res.status(404).json({ error: 'No tienes ninguna puja en esta oferta' }); return
    }

    res.json({ mensaje: 'Puja retirada' })
  } catch {
    res.status(500).json({ error: 'Error al retirar la puja' })
  }
}

export const cerrarOferta = async (req: AuthRequest, res: Response) => {
  const ligaId   = req.params.ligaId as string
  const ofertaId = req.params.ofertaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const [oferta] = await db.select().from(ofertaMercado).where(eq(ofertaMercado.id, ofertaId)).limit(1)
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

export const ventaRapida = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!
  const { jugadorId } = req.body as { jugadorId: string }

  if (!jugadorId) { res.status(400).json({ error: 'jugadorId requerido' }); return }

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const [enPlantilla] = await db.select().from(plantillaFantasy)
      .where(and(eq(plantillaFantasy.ligaId, ligaId), eq(plantillaFantasy.jugadorId, jugadorId))).limit(1)
    if (!enPlantilla || enPlantilla.miembroLigaId !== miembro.id) {
      res.status(403).json({ error: 'No tienes este jugador en tu equipo' }); return
    }

    const [esTitular] = await db.select({ id: titularLiga.jugadorId }).from(titularLiga)
      .where(and(eq(titularLiga.miembroLigaId, miembro.id), eq(titularLiga.jugadorId, jugadorId))).limit(1)
    if (esTitular) { res.status(400).json({ error: 'No puedes hacer venta rápida de un titular' }); return }

    const [jugadorData] = await db.select().from(jugador).where(eq(jugador.id, jugadorId)).limit(1)
    if (!jugadorData) { res.status(404).json({ error: 'Jugador no encontrado' }); return }

    const precio = Math.floor(jugadorData.valor / 2)

    // Cancelar oferta activa si existe
    await db.update(ofertaMercado).set({ estado: 'CANCELADA' })
      .where(and(eq(ofertaMercado.ligaId, ligaId), eq(ofertaMercado.jugadorId, jugadorId), eq(ofertaMercado.estado, 'ACTIVA')))

    // Eliminar de plantilla
    await db.delete(plantillaFantasy)
      .where(and(eq(plantillaFantasy.ligaId, ligaId), eq(plantillaFantasy.jugadorId, jugadorId)))

    const saldoNuevo = miembro.presupuestoRestante + precio
    // Ingresar la mitad del valor al presupuesto
    await db.update(miembroLiga)
      .set({ presupuestoRestante: saldoNuevo })
      .where(eq(miembroLiga.id, miembro.id))

    await registrarMovimientoSaldo(db, {
      miembroLigaId:   miembro.id,
      ligaId,
      concepto:        'VENTA_RAPIDA',
      importe:         precio,
      saldoResultante: saldoNuevo,
      descripcion:     `Venta rápida de ${jugadorData.nombre}`,
      jugadorId,
    })

    res.json({ precio, mensaje: `${jugadorData.nombre} vendido por ${precio}M` })
  } catch {
    res.status(500).json({ error: 'Error en la venta rápida' })
  }
}

export const getTransferencias = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const transferenciasRaw = await db.select().from(transferencia)
      .where(eq(transferencia.ligaId, ligaId)).orderBy(desc(transferencia.fecha))

    const jugadorIds = transferenciasRaw.map(t => t.jugadorId)
    const mlIds      = [...new Set([
      ...transferenciasRaw.map(t => t.vendedorId).filter((v): v is string => v !== null),
      ...transferenciasRaw.map(t => t.compradorId),
    ])]

    const [tJugadoresRaw, tMlRaw] = await Promise.all([
      jugadorIds.length > 0 ? db.select().from(jugador).where(inArray(jugador.id, jugadorIds)) : Promise.resolve([]),
      mlIds.length > 0
        ? db.select({ mlId: miembroLiga.id, uUsername: usuario.username })
            .from(miembroLiga).innerJoin(usuario, eq(usuario.id, miembroLiga.usuarioId))
            .where(inArray(miembroLiga.id, mlIds))
        : Promise.resolve([]),
    ])
    const tJugadorMap = new Map(tJugadoresRaw.map(j => [j.id, j]))
    const tMlMap      = new Map(tMlRaw.map(v => [v.mlId, { id: v.mlId, usuario: { username: v.uUsername } }]))

    const equiposActivos = jugadorIds.length > 0
      ? await db.select({
            jeJugadorId: jugadorEquipo.jugadorId, jeId: jugadorEquipo.id,
            jeEquipoId: jugadorEquipo.equipoId, jeDesde: jugadorEquipo.desde,
            jeHasta: jugadorEquipo.hasta, jeActivo: jugadorEquipo.activo, jeCreadoEn: jugadorEquipo.creadoEn,
            eId: equipo.id, eNombre: equipo.nombre, eDivision: equipo.division, eCreadoEn: equipo.creadoEn,
          })
          .from(jugadorEquipo)
          .innerJoin(equipo, eq(equipo.id, jugadorEquipo.equipoId))
          .where(and(eq(jugadorEquipo.activo, true), inArray(jugadorEquipo.jugadorId, jugadorIds)))
      : []
    const histMap = new Map(equiposActivos.map(r => [r.jeJugadorId, {
      id: r.jeId, jugadorId: r.jeJugadorId, equipoId: r.jeEquipoId,
      desde: r.jeDesde, hasta: r.jeHasta, activo: r.jeActivo, creadoEn: r.jeCreadoEn,
      equipo: { id: r.eId, nombre: r.eNombre, division: r.eDivision, creadoEn: r.eCreadoEn },
    }]))

    res.json(transferenciasRaw.map(t => {
      const j = tJugadorMap.get(t.jugadorId) ?? null
      return {
        ...t,
        jugador:   j ? { ...j, historialEquipos: histMap.has(j.id) ? [histMap.get(j.id)!] : [] } : null,
        vendedor:  t.vendedorId  ? (tMlMap.get(t.vendedorId)  ?? null) : null,
        comprador: tMlMap.get(t.compradorId) ?? null,
      }
    }))
  } catch {
    res.status(500).json({ error: 'Error al obtener el historial' })
  }
}
