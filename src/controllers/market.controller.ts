import { Response } from 'express'
import { prisma } from '../prismaClient'
import { AuthRequest } from '../middleware/auth.middleware'
import { cerrarOfertaLogic } from '../lib/cerrarOfertaLogic'

// ─── HELPER: verificar membresía ───────────────────

async function getMiembro(ligaId: string, usuarioId: string) {
  return prisma.miembroLiga.findUnique({
    where: { ligaId_usuarioId: { ligaId, usuarioId } },
  })
}

// ─── LISTAR OFERTAS ACTIVAS ────────────────────────

export const getOfertasLiga = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const ofertas = await prisma.ofertaMercado.findMany({
      where: { ligaId, estado: 'ACTIVA' },
      include: {
        jugador: {
          include: {
            historialEquipos: { where: { activo: true }, include: { equipo: true }, take: 1 },
          },
        },
        vendedor: { include: { usuario: { select: { username: true } } } },
        _count: { select: { pujas: true } },
        // Solo la puja del propio usuario (sin importe de otros)
        pujas: {
          where: { miembroLigaId: miembro.id },
          select: { cantidad: true },
        },
      },
      orderBy: { creadoEn: 'desc' },
    })

    // Mapear para exponer solo count + mi puja propia
    const respuesta = ofertas.map(o => ({
      ...o,
      numPujas: o._count.pujas,
      miPuja: o.pujas[0]?.cantidad ?? null,
      pujas: undefined,
      _count: undefined,
    }))

    res.json(respuesta)
  } catch {
    res.status(500).json({ error: 'Error al obtener el mercado' })
  }
}

// ─── CREAR OFERTA (solo jugadores propios) ─────────

export const crearOferta = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!
  const { jugadorId, precioMinimo, diasCaducidad } = req.body

  if (!jugadorId || precioMinimo == null) {
    res.status(400).json({ error: 'jugadorId y precioMinimo son obligatorios' })
    return
  }

  if (precioMinimo <= 0) {
    res.status(400).json({ error: 'precioMinimo debe ser mayor que 0' })
    return
  }

  if (diasCaducidad != null && (!Number.isInteger(diasCaducidad) || diasCaducidad < 1 || diasCaducidad > 90)) {
    res.status(400).json({ error: 'diasCaducidad debe ser un número entero entre 1 y 90' })
    return
  }

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const jugadorEnEquipo = await prisma.plantillaFantasy.findUnique({
      where: { ligaId_jugadorId: { ligaId, jugadorId } },
    })
    const esMio = jugadorEnEquipo?.miembroLigaId === miembro.id
    if (!jugadorEnEquipo || !esMio) {
      res.status(403).json({ error: 'No tienes este jugador en tu equipo' })
      return
    }

    const ofertaActiva = await prisma.ofertaMercado.findFirst({
      where: { ligaId, jugadorId, vendedorId: miembro.id, estado: 'ACTIVA' },
    })
    if (ofertaActiva) {
      res.status(409).json({ error: 'Ya tienes este jugador en el mercado' })
      return
    }

    const fechaCaducidad = diasCaducidad
      ? new Date(Date.now() + diasCaducidad * 24 * 60 * 60 * 1000)
      : null

    const oferta = await prisma.ofertaMercado.create({
      data: { ligaId, jugadorId, vendedorId: miembro.id, precioMinimo, fechaCaducidad },
      include: { jugador: true },
    })

    res.status(201).json(oferta)
  } catch {
    res.status(500).json({ error: 'Error al crear la oferta' })
  }
}

// ─── PUJAR ─────────────────────────────────────────

export const pujar = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const ofertaId = req.params.ofertaId as string
  const usuarioId = req.usuarioId!
  const { cantidad } = req.body

  if (cantidad == null || cantidad <= 0) {
    res.status(400).json({ error: 'cantidad debe ser mayor que 0' })
    return
  }

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const oferta = await prisma.ofertaMercado.findUnique({ where: { id: ofertaId } })
    if (!oferta || oferta.ligaId !== ligaId) {
      res.status(404).json({ error: 'Oferta no encontrada' })
      return
    }
    if (oferta.estado !== 'ACTIVA') {
      res.status(409).json({ error: 'La oferta ya no está activa' })
      return
    }
    if (oferta.vendedorId === miembro.id) {
      res.status(400).json({ error: 'No puedes pujar por tu propio jugador' })
      return
    }
    if (cantidad < oferta.precioMinimo) {
      res.status(400).json({ error: `La puja mínima es ${oferta.precioMinimo}` })
      return
    }
    if (cantidad > miembro.presupuestoRestante) {
      res.status(400).json({ error: 'Presupuesto insuficiente' })
      return
    }

    const pujaActual = await prisma.puja.findUnique({
      where: { ofertaMercadoId_miembroLigaId: { ofertaMercadoId: ofertaId, miembroLigaId: miembro.id } },
    })
    if (pujaActual && cantidad <= pujaActual.cantidad) {
      res.status(400).json({ error: `Tu puja debe superar tu oferta actual (${pujaActual.cantidad})` })
      return
    }

    const puja = await prisma.puja.upsert({
      where: { ofertaMercadoId_miembroLigaId: { ofertaMercadoId: ofertaId, miembroLigaId: miembro.id } },
      update: { cantidad },
      create: { ofertaMercadoId: ofertaId, miembroLigaId: miembro.id, cantidad },
    })

    res.json(puja)
  } catch {
    res.status(500).json({ error: 'Error al registrar la puja' })
  }
}

// ─── CERRAR OFERTA ─────────────────────────────────

export const cerrarOferta = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const ofertaId = req.params.ofertaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const oferta = await prisma.ofertaMercado.findUnique({
      where: { id: ofertaId },
      include: { pujas: { orderBy: { cantidad: 'desc' }, take: 1 } },
    })

    if (!oferta || oferta.ligaId !== ligaId) {
      res.status(404).json({ error: 'Oferta no encontrada' })
      return
    }
    if (oferta.estado !== 'ACTIVA') {
      res.status(409).json({ error: 'La oferta ya no está activa' })
      return
    }
    if (oferta.vendedorId !== miembro.id) {
      res.status(403).json({ error: 'Solo el vendedor puede cerrar esta oferta' })
      return
    }

    const resultado = await cerrarOfertaLogic(ofertaId)

    if (resultado?.resultado === 'CANCELADA') {
      res.json({ mensaje: 'Oferta cancelada: ningún equipo realizó pujas' })
      return
    }

    res.json({ mensaje: 'Oferta cerrada. Transferencia completada.' })
  } catch {
    res.status(500).json({ error: 'Error al cerrar la oferta' })
  }
}

// ─── CANCELAR OFERTA ───────────────────────────────

export const cancelarOferta = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const ofertaId = req.params.ofertaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const oferta = await prisma.ofertaMercado.findUnique({ where: { id: ofertaId } })
    if (!oferta || oferta.ligaId !== ligaId) {
      res.status(404).json({ error: 'Oferta no encontrada' })
      return
    }
    if (oferta.estado !== 'ACTIVA') {
      res.status(409).json({ error: 'La oferta ya no está activa' })
      return
    }
    if (oferta.vendedorId !== miembro.id) {
      res.status(403).json({ error: 'Solo el vendedor puede cancelar esta oferta' })
      return
    }

    await prisma.ofertaMercado.update({ where: { id: ofertaId }, data: { estado: 'CANCELADA' } })
    res.json({ mensaje: 'Oferta cancelada' })
  } catch {
    res.status(500).json({ error: 'Error al cancelar la oferta' })
  }
}

// ─── HISTORIAL DE TRANSFERENCIAS ──────────────────

export const getTransferencias = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const transferencias = await prisma.transferencia.findMany({
      where: { ligaId },
      include: {
        jugador: {
          include: {
            historialEquipos: { where: { activo: true }, include: { equipo: true }, take: 1 },
          },
        },
        vendedor: { include: { usuario: { select: { username: true } } } },
        comprador: { include: { usuario: { select: { username: true } } } },
      },
      orderBy: { fecha: 'desc' },
    })

    res.json(transferencias)
  } catch {
    res.status(500).json({ error: 'Error al obtener el historial' })
  }
}
