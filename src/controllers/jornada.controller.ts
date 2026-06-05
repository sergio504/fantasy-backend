import { Response } from 'express'
import { AuthRequest } from '../middleware/auth.middleware'
import { prisma } from '../prismaClient'
import { Division, Posicion, AccionPuntuacion, ResultadoPartido } from '@prisma/client'
import { registrarAccion } from '../lib/registrarAccion'

// ─── HELPERS ───────────────────────────────────────

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function prob(p: number) {
  return Math.random() < p
}

// Obtiene la config activa para una posición+acción en una fecha dada
function getPuntos(
  config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[],
  accion: AccionPuntuacion,
  posicion: Posicion
): number {
  // Buscar primero config específica de posición, luego global (null)
  const especifica = config.find(c => c.accion === accion && c.posicion === posicion)
  if (especifica) return especifica.puntos
  const global = config.find(c => c.accion === accion && c.posicion === null)
  return global?.puntos ?? 0
}

function calcularPuntos(
  stats: {
    convocado: boolean; titular: boolean; minutosJugados: number
    goles: number; tarjetasAmarillas: number; tarjetaRoja: boolean
    resultado: ResultadoPartido
  },
  posicion: Posicion,
  config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[]
) {
  const desglose: Record<string, unknown> = {}
  let total = 0

  if (stats.convocado) {
    const p = getPuntos(config, 'CONVOCADO', posicion)
    desglose.convocado = p; total += p
  }
  if (stats.titular) {
    const p = getPuntos(config, 'TITULAR', posicion)
    desglose.titular = p; total += p
  }
  if (stats.minutosJugados > 60) {
    const p = getPuntos(config, 'MINUTOS_60', posicion)
    desglose.minutos60 = p; total += p
  }
  if (stats.goles > 0) {
    const pUnit = getPuntos(config, 'GOL', posicion)
    const pTotal = pUnit * stats.goles
    desglose.goles = { cantidad: stats.goles, puntosUnitarios: pUnit, total: pTotal }
    total += pTotal
  }
  if (stats.tarjetasAmarillas > 0) {
    const pUnit = getPuntos(config, 'TARJETA_AMARILLA', posicion)
    const pTotal = pUnit * stats.tarjetasAmarillas
    desglose.tarjetasAmarillas = { cantidad: stats.tarjetasAmarillas, puntosUnitarios: pUnit, total: pTotal }
    total += pTotal
  }
  if (stats.tarjetaRoja) {
    const p = getPuntos(config, 'TARJETA_ROJA', posicion)
    desglose.tarjetaRoja = p; total += p
  }

  const accionResultado: AccionPuntuacion = stats.resultado === 'VICTORIA' ? 'VICTORIA'
    : stats.resultado === 'EMPATE' ? 'EMPATE' : 'DERROTA'
  const pRes = getPuntos(config, accionResultado, posicion)
  desglose.resultado = { tipo: stats.resultado, puntos: pRes }
  total += pRes

  return { total, desglose }
}

// ─── CREAR JORNADA ─────────────────────────────────

export const crearJornada = async (req: AuthRequest, res: Response) => {
  const { division, numJornada, fechaCierre } = req.body

  if (!division || !numJornada || !fechaCierre) {
    res.status(400).json({ error: 'division, numJornada y fechaCierre son obligatorios' })
    return
  }

  try {
    const jornada = await prisma.jornada.create({
      data: { division, numJornada, fechaCierre: new Date(fechaCierre) },
    })
    await registrarAccion(req.usuarioId!, 'CREAR_JORNADA', 'Jornada', jornada.id, jornada)
    res.status(201).json(jornada)
  } catch {
    res.status(409).json({ error: 'Ya existe esa jornada para esa división' })
  }
}

export const getJornadas = async (req: AuthRequest, res: Response) => {
  const { division } = req.query
  try {
    const jornadas = await prisma.jornada.findMany({
      where: division ? { division: division as Division } : undefined,
      orderBy: [{ division: 'asc' }, { numJornada: 'asc' }],
      include: {
        _count: { select: { estadisticas: true, snapshots: true, puntuaciones: true } },
      },
    })
    res.json(jornadas)
  } catch {
    res.status(500).json({ error: 'Error al obtener jornadas' })
  }
}

// ─── SIMULAR ESTADÍSTICAS ──────────────────────────

export const simularJornada = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string

  try {
    const jornada = await prisma.jornada.findUnique({ where: { id: jornadaId } })
    if (!jornada) {
      res.status(404).json({ error: 'Jornada no encontrada' })
      return
    }

    // No simular si ya tiene estadísticas
    const yaSimulada = await prisma.estadisticaJornada.count({ where: { jornadaId } })
    if (yaSimulada > 0) {
      res.status(409).json({ error: 'Esta jornada ya tiene estadísticas. Bórralas primero.' })
      return
    }

    // Config activa en la fecha de la jornada
    const config = await prisma.configPuntuacion.findMany({
      where: {
        activo: true,
        desde: { lte: jornada.fechaCierre },
        OR: [{ hasta: null }, { hasta: { gte: jornada.fechaCierre } }],
      },
    })

    // Jugadores activos en esa división
    const jugadoresEquipo = await prisma.jugadorEquipo.findMany({
      where: { activo: true, equipo: { division: jornada.division } },
      include: { jugador: true },
    })

    // Simular resultado por equipo (todos los del mismo equipoId comparten resultado)
    const resultadosPorEquipo = new Map<string, ResultadoPartido>()
    const resultados: ResultadoPartido[] = ['VICTORIA', 'EMPATE', 'DERROTA']

    const estadisticas = []

    for (const je of jugadoresEquipo) {
      if (!resultadosPorEquipo.has(je.equipoId)) {
        resultadosPorEquipo.set(je.equipoId, resultados[rand(0, 2)])
      }
      const resultado = resultadosPorEquipo.get(je.equipoId)!

      // Probabilidades realistas
      const convocado         = prob(0.75)
      const titular           = convocado && prob(0.65)
      const minutosJugados    = titular ? rand(45, 95) : convocado && prob(0.4) ? rand(1, 44) : 0
      const goles             = minutosJugados > 0 ? (prob(0.12) ? rand(1, 2) : 0) : 0
      const tarjetasAmarillas = minutosJugados > 0 ? (prob(0.15) ? 1 : 0) : 0
      const tarjetaRoja       = minutosJugados > 0 && !tarjetasAmarillas && prob(0.03)

      const { total, desglose } = calcularPuntos(
        { convocado, titular, minutosJugados, goles, tarjetasAmarillas, tarjetaRoja, resultado },
        je.jugador.posicion,
        config
      )

      estadisticas.push({
        jornadaId,
        jugadorEquipoId: je.id,
        convocado, titular, minutosJugados, goles, tarjetasAmarillas, tarjetaRoja,
        resultado,
        puntosCalculados: total,
        desglose: desglose as any,
      })
    }

    await prisma.estadisticaJornada.createMany({ data: estadisticas })
    await registrarAccion(req.usuarioId!, 'SIMULAR_JORNADA', 'Jornada', jornadaId, { jornadaId, total: estadisticas.length })

    res.json({ mensaje: `${estadisticas.length} estadísticas simuladas`, jornadaId })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al simular' })
  }
}

// ─── GENERAR SNAPSHOT DE ALINEACIONES ─────────────

export const generarSnapshot = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string

  try {
    const jornada = await prisma.jornada.findUnique({ where: { id: jornadaId } })
    if (!jornada) {
      res.status(404).json({ error: 'Jornada no encontrada' })
      return
    }

    const yaExiste = await prisma.snapshotAlineacion.count({ where: { jornadaId } })
    if (yaExiste > 0) {
      res.status(409).json({ error: 'Esta jornada ya tiene snapshot generado' })
      return
    }

    // Todas las ligas de esta división
    const ligas = await prisma.liga.findMany({ where: { division: jornada.division } })
    const ligaIds = ligas.map(l => l.id)

    // Todos los miembros de esas ligas con sus titulares
    const miembros = await prisma.miembroLiga.findMany({
      where: { ligaId: { in: ligaIds } },
      include: {
        titulares: {
          include: {
            jugador: {
              include: {
                historialEquipos: { where: { activo: true }, take: 1 },
              },
            },
          },
        },
      },
    })

    const snapshots: { jornadaId: string; miembroLigaId: string; jugadorEquipoId: string; esCapitan: boolean }[] = []

    for (const miembro of miembros) {
      if (miembro.titulares.length === 0) continue
      for (const titular of miembro.titulares) {
        const je = titular.jugador.historialEquipos[0]
        if (!je) continue
        snapshots.push({
          jornadaId,
          miembroLigaId: miembro.id,
          jugadorEquipoId: je.id,
          esCapitan: miembro.capitanId === titular.jugadorId,
        })
      }
    }

    await prisma.snapshotAlineacion.createMany({ data: snapshots, skipDuplicates: true })
    await registrarAccion(req.usuarioId!, 'GENERAR_SNAPSHOT', 'Jornada', jornadaId, { jornadaId, total: snapshots.length })

    res.json({ mensaje: `Snapshot generado: ${snapshots.length} entradas`, jornadaId })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al generar snapshot' })
  }
}

// ─── CALCULAR PUNTUACIONES DE USUARIOS ─────────────

export const calcularPuntuaciones = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string

  try {
    const jornada = await prisma.jornada.findUnique({ where: { id: jornadaId } })
    if (!jornada) {
      res.status(404).json({ error: 'Jornada no encontrada' })
      return
    }

    // Snapshots de esta jornada con su jugadorEquipo
    const snapshots = await prisma.snapshotAlineacion.findMany({
      where: { jornadaId },
    })

    if (snapshots.length === 0) {
      res.status(409).json({ error: 'No hay snapshots para esta jornada. Genera primero el cierre de jornada.' })
      return
    }

    // Estadísticas indexadas por jugadorEquipoId
    const estadisticas = await prisma.estadisticaJornada.findMany({ where: { jornadaId } })
    const statsMap = new Map(estadisticas.map(e => [e.jugadorEquipoId, e]))

    // Agrupar snapshots por miembroLigaId
    const porMiembro = new Map<string, typeof snapshots>()
    for (const s of snapshots) {
      if (!porMiembro.has(s.miembroLigaId)) porMiembro.set(s.miembroLigaId, [])
      porMiembro.get(s.miembroLigaId)!.push(s)
    }

    let calculados = 0

    for (const [miembroLigaId, snaps] of porMiembro) {
      let totalPuntos = 0

      for (const snap of snaps) {
        const stats = statsMap.get(snap.jugadorEquipoId)
        if (!stats) continue
        const puntos = snap.esCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados
        totalPuntos += puntos
      }

      await prisma.puntuacionJornada.upsert({
        where: { jornadaId_miembroLigaId: { jornadaId, miembroLigaId } },
        update: { puntos: totalPuntos },
        create: { jornadaId, miembroLigaId, puntos: totalPuntos },
      })

      // Actualizar puntuación acumulada del miembro
      await prisma.miembroLiga.update({
        where: { id: miembroLigaId },
        data: { puntuacion: { increment: totalPuntos } },
      })

      calculados++
    }

    await registrarAccion(req.usuarioId!, 'CALCULAR_PUNTUACIONES', 'Jornada', jornadaId, { jornadaId, equipos: calculados })

    res.json({ mensaje: `Puntuaciones calculadas para ${calculados} equipos`, jornadaId })
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al calcular puntuaciones' })
  }
}

// ─── DETALLE PUNTUACIÓN DE UNA JORNADA ─────────────

export const getPuntuacionesJornada = async (req: AuthRequest, res: Response) => {
  const { ligaId, jornadaId } = req.params as { ligaId: string; jornadaId: string }

  try {
    const puntuaciones = await prisma.puntuacionJornada.findMany({
      where: {
        jornadaId,
        miembroLiga: { ligaId },
      },
      include: {
        miembroLiga: { include: { usuario: { select: { username: true } } } },
      },
      orderBy: { puntos: 'desc' },
    })

    res.json(puntuaciones)
  } catch {
    res.status(500).json({ error: 'Error al obtener puntuaciones' })
  }
}

export const getEstadisticasJornada = async (req: AuthRequest, res: Response) => {
  const { ligaId, jornadaId } = req.params as { ligaId: string; jornadaId: string }
  const usuarioId = req.usuarioId!

  try {
    const miembro = await prisma.miembroLiga.findUnique({
      where: { ligaId_usuarioId: { ligaId, usuarioId } },
    })
    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const snapshots = await prisma.snapshotAlineacion.findMany({
      where: { jornadaId, miembroLigaId: miembro.id },
      include: {
        jugadorEquipo: {
          include: {
            jugador: true,
            estadisticas: { where: { jornadaId } },
          },
        },
      },
    })

    const resultado = snapshots.map(s => {
      const stats = s.jugadorEquipo.estadisticas[0] ?? null
      const puntos = stats
        ? (s.esCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados)
        : null
      return {
        jugador: {
          nombreCompleto: s.jugadorEquipo.jugador.nombreCompleto,
          posicion: s.jugadorEquipo.jugador.posicion,
        },
        esCapitan: s.esCapitan,
        estadistica: stats,
        puntos,
      }
    })

    res.json(resultado)
  } catch {
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
}
