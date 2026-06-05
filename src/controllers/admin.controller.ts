import { Response } from 'express'
import { AuthRequest } from '../middleware/auth.middleware'
import { prisma } from '../prismaClient'
import { Posicion, Division, AccionPuntuacion, ResultadoPartido } from '@prisma/client'
import { registrarAccion as registrar } from '../lib/registrarAccion'

// ─── JUGADORES ─────────────────────────────────────

export const getJugadoresAdmin = async (_req: AuthRequest, res: Response) => {
  try {
    const jugadores = await prisma.jugador.findMany({
      include: {
        historialEquipos: {
          where: { activo: true },
          include: { equipo: true },
          take: 1,
        },
      },
      orderBy: { nombreCompleto: 'asc' },
    })
    res.json(jugadores)
  } catch {
    res.status(500).json({ error: 'Error al obtener jugadores' })
  }
}

export const crearJugador = async (req: AuthRequest, res: Response) => {
  const { nombreCompleto, nombre, dorsal, edad, posicion } = req.body

  if (!nombreCompleto || !nombre || !posicion) {
    res.status(400).json({ error: 'nombreCompleto, nombre y posicion son obligatorios' })
    return
  }

  if (!Object.values(Posicion).includes(posicion)) {
    res.status(400).json({ error: `posicion debe ser uno de: ${Object.values(Posicion).join(', ')}` })
    return
  }

  try {
    const jugador = await prisma.jugador.create({
      data: { nombreCompleto, nombre, dorsal, edad, posicion },
    })

    await registrar(req.usuarioId!, 'CREAR_JUGADOR', 'Jugador', jugador.id, jugador)

    res.status(201).json(jugador)
  } catch {
    res.status(500).json({ error: 'Error al crear jugador' })
  }
}

export const editarJugador = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const { nombreCompleto, nombre, dorsal, edad, posicion, valor } = req.body

  try {
    const antes = await prisma.jugador.findUnique({ where: { id } })
    if (!antes) {
      res.status(404).json({ error: 'Jugador no encontrado' })
      return
    }

    const despues = await prisma.jugador.update({
      where: { id },
      data: {
        ...(nombreCompleto !== undefined && { nombreCompleto }),
        ...(nombre !== undefined && { nombre }),
        ...(dorsal !== undefined && { dorsal }),
        ...(edad !== undefined && { edad }),
        ...(posicion !== undefined && { posicion }),
        ...(valor !== undefined && { valor }),
      },
    })

    await registrar(req.usuarioId!, 'EDITAR_JUGADOR', 'Jugador', id, despues, antes)

    res.json(despues)
  } catch {
    res.status(500).json({ error: 'Error al editar jugador' })
  }
}

// ─── FICHAJES ──────────────────────────────────────

export const crearFichaje = async (req: AuthRequest, res: Response) => {
  const { jugadorId, equipoId, desde } = req.body

  if (!jugadorId || !equipoId) {
    res.status(400).json({ error: 'jugadorId y equipoId son obligatorios' })
    return
  }

  try {
    // Cerrar el fichaje activo anterior si existe
    await prisma.jugadorEquipo.updateMany({
      where: { jugadorId, activo: true },
      data: { activo: false, hasta: desde ? new Date(desde) : new Date() },
    })

    const fichaje = await prisma.jugadorEquipo.create({
      data: {
        jugadorId,
        equipoId,
        desde: desde ? new Date(desde) : new Date(),
        activo: true,
      },
      include: { jugador: true, equipo: true },
    })

    await registrar(req.usuarioId!, 'CREAR_FICHAJE', 'JugadorEquipo', fichaje.id, fichaje)

    res.status(201).json(fichaje)
  } catch {
    res.status(500).json({ error: 'Error al crear fichaje' })
  }
}

export const cerrarFichaje = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const { hasta } = req.body

  try {
    const antes = await prisma.jugadorEquipo.findUnique({ where: { id } })
    if (!antes) {
      res.status(404).json({ error: 'Fichaje no encontrado' })
      return
    }

    const despues = await prisma.jugadorEquipo.update({
      where: { id },
      data: { activo: false, hasta: hasta ? new Date(hasta) : new Date() },
    })

    await registrar(req.usuarioId!, 'CERRAR_FICHAJE', 'JugadorEquipo', id, despues, antes)

    res.json(despues)
  } catch {
    res.status(500).json({ error: 'Error al cerrar fichaje' })
  }
}

// ─── EQUIPOS ───────────────────────────────────────

export const getEquipos = async (_req: AuthRequest, res: Response) => {
  try {
    const equipos = await prisma.equipo.findMany({ orderBy: [{ division: 'asc' }, { nombre: 'asc' }] })
    res.json(equipos)
  } catch {
    res.status(500).json({ error: 'Error al obtener equipos' })
  }
}

// ─── ESTADÍSTICAS ──────────────────────────────────

export const getEstadisticasJornada = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string
  try {
    const stats = await prisma.estadisticaJornada.findMany({
      where: { jornadaId },
      include: {
        jugadorEquipo: { include: { jugador: true, equipo: true } },
      },
      orderBy: { jugadorEquipo: { jugador: { nombreCompleto: 'asc' } } },
    })
    res.json(stats)
  } catch {
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
}

function recalcularPuntos(
  stats: { convocado: boolean; titular: boolean; minutosJugados: number; goles: number; tarjetasAmarillas: number; tarjetaRoja: boolean; resultado: ResultadoPartido },
  posicion: Posicion,
  config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[]
) {
  function get(accion: AccionPuntuacion): number {
    return config.find(c => c.accion === accion && c.posicion === posicion)?.puntos
      ?? config.find(c => c.accion === accion && c.posicion === null)?.puntos ?? 0
  }
  const d: Record<string, unknown> = {}
  let total = 0
  if (stats.convocado) { const p = get('CONVOCADO'); d.convocado = p; total += p }
  if (stats.titular)   { const p = get('TITULAR');   d.titular   = p; total += p }
  if (stats.minutosJugados > 60) { const p = get('MINUTOS_60'); d.minutos60 = p; total += p }
  if (stats.goles > 0) { const u = get('GOL'); const t = u * stats.goles; d.goles = { cantidad: stats.goles, puntosUnitarios: u, total: t }; total += t }
  if (stats.tarjetasAmarillas > 0) { const u = get('TARJETA_AMARILLA'); const t = u * stats.tarjetasAmarillas; d.tarjetasAmarillas = { cantidad: stats.tarjetasAmarillas, puntosUnitarios: u, total: t }; total += t }
  if (stats.tarjetaRoja) { const p = get('TARJETA_ROJA'); d.tarjetaRoja = p; total += p }
  const accionRes: AccionPuntuacion = stats.resultado === 'VICTORIA' ? 'VICTORIA' : stats.resultado === 'EMPATE' ? 'EMPATE' : 'DERROTA'
  const pRes = get(accionRes); d.resultado = { tipo: stats.resultado, puntos: pRes }; total += pRes
  return { total, desglose: d }
}

export const editarEstadistica = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const { convocado, titular, minutosJugados, goles, tarjetasAmarillas, tarjetaRoja, resultado } = req.body

  try {
    const antes = await prisma.estadisticaJornada.findUnique({
      where: { id },
      include: { jugadorEquipo: { include: { jugador: true } }, jornada: true },
    })
    if (!antes) { res.status(404).json({ error: 'Estadística no encontrada' }); return }

    const nuevosDatos = {
      convocado:         convocado         ?? antes.convocado,
      titular:           titular           ?? antes.titular,
      minutosJugados:    minutosJugados    ?? antes.minutosJugados,
      goles:             goles             ?? antes.goles,
      tarjetasAmarillas: tarjetasAmarillas ?? antes.tarjetasAmarillas,
      tarjetaRoja:       tarjetaRoja       ?? antes.tarjetaRoja,
      resultado:         resultado         ?? antes.resultado,
    }

    // Config activa en la fecha de la jornada
    const config = await prisma.configPuntuacion.findMany({
      where: {
        activo: true,
        desde: { lte: antes.jornada.fechaCierre },
        OR: [{ hasta: null }, { hasta: { gte: antes.jornada.fechaCierre } }],
      },
    })

    const { total, desglose } = recalcularPuntos(nuevosDatos, antes.jugadorEquipo.jugador.posicion, config)
    const puntosAntes = antes.puntosCalculados
    const diferencia = total - puntosAntes

    const despues = await prisma.estadisticaJornada.update({
      where: { id },
      data: { ...nuevosDatos, puntosCalculados: total, desglose: desglose as any },
    })

    // Recalcular PuntuacionJornada afectadas (usuarios que tenían este jugadorEquipo en snapshot)
    if (diferencia !== 0) {
      const snapshots = await prisma.snapshotAlineacion.findMany({
        where: { jornadaId: antes.jornadaId, jugadorEquipoId: antes.jugadorEquipoId },
      })
      for (const snap of snapshots) {
        const delta = snap.esCapitan ? diferencia * 2 : diferencia
        await prisma.puntuacionJornada.updateMany({
          where: { jornadaId: antes.jornadaId, miembroLigaId: snap.miembroLigaId },
          data: { puntos: { increment: delta } },
        })
        await prisma.miembroLiga.update({
          where: { id: snap.miembroLigaId },
          data: { puntuacion: { increment: delta } },
        })
      }
    }

    await registrar(req.usuarioId!, 'EDITAR_ESTADISTICA', 'EstadisticaJornada', id, despues as object, antes as object)

    res.json({ ...despues, puntosAntes, diferencia })
  } catch {
    res.status(500).json({ error: 'Error al editar estadística' })
  }
}

// ─── CONFIG PUNTUACIÓN ─────────────────────────────

export const getConfigPuntuacion = async (_req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.configPuntuacion.findMany({
      where: { activo: true },
      orderBy: [{ posicion: 'asc' }, { accion: 'asc' }],
    })
    res.json(config)
  } catch {
    res.status(500).json({ error: 'Error al obtener configuración' })
  }
}

export const actualizarConfigPuntuacion = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const { puntos, descripcion } = req.body

  if (puntos === undefined) { res.status(400).json({ error: 'puntos es obligatorio' }); return }

  try {
    const actual = await prisma.configPuntuacion.findUnique({ where: { id } })
    if (!actual || !actual.activo) { res.status(404).json({ error: 'Configuración no encontrada' }); return }

    const ahora = new Date()

    // Cerrar la actual
    await prisma.configPuntuacion.update({
      where: { id },
      data: { activo: false, hasta: ahora },
    })

    // Crear nueva versión
    const nueva = await prisma.configPuntuacion.create({
      data: {
        posicion:    actual.posicion,
        accion:      actual.accion,
        puntos,
        desde:       ahora,
        activo:      true,
        descripcion: descripcion ?? actual.descripcion,
      },
    })

    await registrar(req.usuarioId!, 'ACTUALIZAR_CONFIG', 'ConfigPuntuacion', nueva.id, nueva as object, actual as object)

    res.json(nueva)
  } catch {
    res.status(500).json({ error: 'Error al actualizar configuración' })
  }
}

// ─── USUARIOS ──────────────────────────────────────

export const getUsuarios = async (_req: AuthRequest, res: Response) => {
  try {
    const usuarios = await prisma.usuario.findMany({
      select: {
        id: true, email: true, username: true, esAdmin: true, activo: true, creadoEn: true,
        _count: { select: { membresias: true, ligasCreadas: true } },
      },
      orderBy: { creadoEn: 'asc' },
    })
    res.json(usuarios)
  } catch {
    res.status(500).json({ error: 'Error al obtener usuarios' })
  }
}

export const toggleActivoUsuario = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string

  if (id === req.usuarioId) {
    res.status(400).json({ error: 'No puedes desactivarte a ti mismo' })
    return
  }

  try {
    const usuario = await prisma.usuario.findUnique({ where: { id } })
    if (!usuario) { res.status(404).json({ error: 'Usuario no encontrado' }); return }

    const actualizado = await prisma.usuario.update({
      where: { id },
      data: { activo: !usuario.activo },
      select: { id: true, username: true, activo: true },
    })

    await registrar(
      req.usuarioId!, 'EDITAR_JUGADOR', 'Usuario', id,
      { activo: actualizado.activo },
      { activo: usuario.activo }
    )

    res.json(actualizado)
  } catch {
    res.status(500).json({ error: 'Error al actualizar usuario' })
  }
}

// ─── MERCADO AUTOMÁTICO (disparo manual) ───────────

export const lanzarMercadoManual = async (req: AuthRequest, res: Response) => {
  try {
    const { ponerJugadoresEnMercado } = await import('../jobs/mercadoAutomatico')
    const resumen = await ponerJugadoresEnMercado()
    const totalAñadidos = resumen.reduce((s, r) => s + r.añadidos, 0)

    await registrar(req.usuarioId!, 'CREAR_JORNADA', 'Mercado', 'manual', { resumen, totalAñadidos })

    res.json({ mensaje: `${totalAñadidos} jugadores añadidos al mercado`, resumen })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al lanzar mercado' })
  }
}

// ─── DASHBOARD ─────────────────────────────────────

export const getDashboard = async (_req: AuthRequest, res: Response) => {
  try {
    const ahora = new Date()
    const haceUnaSemana = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000)

    const [
      totalUsuarios,
      nuevosUltimaSemana,
      accesosUltimaSemana,
      ligasPublicas,
      ligasPrivadas,
      totalJugadores,
      ofertasActivas,
      ofertasVendidas,
      ofertasCanceladas,
      totalPujas,
      usuariosRecientes,
    ] = await Promise.all([
      prisma.usuario.count(),
      prisma.usuario.count({ where: { creadoEn: { gte: haceUnaSemana } } }),
      prisma.usuario.count({ where: { ultimoAcceso: { gte: haceUnaSemana } } }),
      prisma.liga.count({ where: { publica: true } }),
      prisma.liga.count({ where: { publica: false } }),
      prisma.jugador.count(),
      prisma.ofertaMercado.count({ where: { estado: 'ACTIVA' } }),
      prisma.ofertaMercado.count({ where: { estado: 'VENDIDA' } }),
      prisma.ofertaMercado.count({ where: { estado: 'CANCELADA' } }),
      prisma.puja.count(),
      prisma.usuario.findMany({ where: { creadoEn: { gte: haceUnaSemana } }, select: { creadoEn: true } }),
    ])

    const registrosPorDia: { dia: string; usuarios: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(ahora)
      d.setDate(d.getDate() - i)
      const diaStr = d.toISOString().split('T')[0]
      const count = usuariosRecientes.filter(u => u.creadoEn.toISOString().split('T')[0] === diaStr).length
      registrosPorDia.push({ dia: diaStr, usuarios: count })
    }

    res.json({
      usuarios: { total: totalUsuarios, nuevosUltimaSemana, accesosUltimaSemana },
      ligas: { publicas: ligasPublicas, privadas: ligasPrivadas, total: ligasPublicas + ligasPrivadas },
      jugadores: { total: totalJugadores },
      mercado: { ofertasActivas, ofertasVendidas, ofertasCanceladas, totalPujas },
      registrosPorDia,
    })
  } catch {
    res.status(500).json({ error: 'Error al obtener dashboard' })
  }
}

// ─── HISTORIAL ─────────────────────────────────────

export const getHistorial = async (_req: AuthRequest, res: Response) => {
  try {
    const historial = await prisma.historialAdmin.findMany({
      include: { admin: { select: { username: true } } },
      orderBy: { creadoEn: 'desc' },
      take: 500,
    })
    res.json(historial)
  } catch {
    res.status(500).json({ error: 'Error al obtener historial' })
  }
}
