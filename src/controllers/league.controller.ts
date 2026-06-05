import { Request, Response } from 'express'
import { prisma } from '../prismaClient'
import { AuthRequest } from '../middleware/auth.middleware'
import { Division, Posicion, Prisma } from '@prisma/client'
import crypto from 'crypto'

type LigaConConteo = Prisma.LigaGetPayload<{ include: { _count: { select: { miembros: true } } } }>
type LigaDetalle = Prisma.LigaGetPayload<{
  include: { miembros: { include: { usuario: { select: { id: true; username: true } } } } }
}>

// ─── HELPER: asignar 16 jugadores aleatorios al unirse ─

const CUPOS: Record<Posicion, number> = {
  PORTERO: 2,
  DEFENSA: 5,
  CENTROCAMPISTA: 5,
  DELANTERO: 4,
  UNKNOWN: 0,
}

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

export async function asignarJugadoresIniciales(
  miembroLigaId: string,
  ligaId: string,
  division: Division,
  tx: Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>
) {
  // Jugadores ya asignados en esta liga (propiedad exclusiva por liga)
  const ocupados = await tx.plantillaFantasy.findMany({
    where: { ligaId },
    select: { jugadorId: true },
  })
  const idsOcupados = ocupados.map(pf => pf.jugadorId)

  const posiciones = (Object.keys(CUPOS) as Posicion[]).filter(p => CUPOS[p] > 0)
  const lotes = await Promise.all(
    posiciones.map(pos =>
      tx.jugador.findMany({
        where: {
          posicion: pos,
          id: { notIn: idsOcupados },
          historialEquipos: { some: { activo: true, equipo: { division } } },
        },
      })
    )
  )

  const seleccionados = posiciones.flatMap((pos, i) =>
    shuffle(lotes[i]).slice(0, CUPOS[pos])
  )

  if (seleccionados.length < 16) {
    throw new Error(`No hay suficientes jugadores libres en la división ${division} para formar un equipo completo`)
  }

  await tx.plantillaFantasy.createMany({
    data: seleccionados.map(j => ({
      ligaId,
      miembroLigaId,
      jugadorId: j.id,
      precioCompra: j.valor,
    })),
  })
}

// ─── CREAR LIGA ────────────────────────────────────

export const crearLiga = async (req: AuthRequest, res: Response) => {
  const { nombre, division, publica, maxEquipos, presupuestoInicial } = req.body
  const creadorId = req.usuarioId!

  if (!nombre || !division) {
    res.status(400).json({ error: 'nombre y division son obligatorios' })
    return
  }

  if (!Object.values(Division).includes(division)) {
    res.status(400).json({ error: `division debe ser uno de: ${Object.values(Division).join(', ')}` })
    return
  }

  try {
    const esPublica = publica !== false
    const codigoInvitacion = esPublica ? null : crypto.randomBytes(6).toString('hex')
    const presupuesto = presupuestoInicial ?? 100

    const liga = await prisma.$transaction(async tx => {
      const ligaCreada = await tx.liga.create({
        data: {
          nombre,
          creadorId,
          division,
          publica: esPublica,
          codigoInvitacion,
          maxEquipos: maxEquipos ?? 10,
          presupuestoInicial: presupuesto,
          miembros: {
            create: { usuarioId: creadorId, presupuestoRestante: presupuesto },
          },
        },
        include: { miembros: true },
      })

      await asignarJugadoresIniciales(ligaCreada.miembros[0].id, ligaCreada.id, division, tx)

      return ligaCreada
    })

    res.status(201).json(liga)
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al crear la liga' })
  }
}

// ─── UNIRSE A LIGA PÚBLICA ─────────────────────────

export const unirseALiga = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const liga = await prisma.liga.findUnique({ where: { id: ligaId } })

    if (!liga) {
      res.status(404).json({ error: 'Liga no encontrada' })
      return
    }

    if (!liga.publica) {
      res.status(403).json({ error: 'Liga privada: usa el código de invitación' })
      return
    }

    const numMiembros = await prisma.miembroLiga.count({ where: { ligaId } })
    if (numMiembros >= liga.maxEquipos) {
      res.status(409).json({ error: 'La liga está llena' })
      return
    }

    const miembro = await prisma.$transaction(async tx => {
      const nuevo = await tx.miembroLiga.create({
        data: { ligaId, usuarioId, presupuestoRestante: liga.presupuestoInicial },
      })
      await asignarJugadoresIniciales(nuevo.id, ligaId, liga.division, tx)
      return nuevo
    })

    res.status(201).json(miembro)
  } catch (e: any) {
    if (e?.code === 'P2002') {
      res.status(409).json({ error: 'Ya eres miembro de esta liga' })
      return
    }
    res.status(500).json({ error: e.message ?? 'Error al unirse a la liga' })
  }
}

// ─── UNIRSE A LIGA PRIVADA (con código) ────────────

export const unirseConCodigo = async (req: AuthRequest, res: Response) => {
  const { codigo } = req.body
  const usuarioId = req.usuarioId!

  if (!codigo) {
    res.status(400).json({ error: 'codigo es obligatorio' })
    return
  }

  try {
    const liga = await prisma.liga.findUnique({ where: { codigoInvitacion: codigo } })

    if (!liga) {
      res.status(404).json({ error: 'Código de invitación no válido' })
      return
    }

    const numMiembros = await prisma.miembroLiga.count({ where: { ligaId: liga.id } })
    if (numMiembros >= liga.maxEquipos) {
      res.status(409).json({ error: 'La liga está llena' })
      return
    }

    const miembro = await prisma.$transaction(async tx => {
      const nuevo = await tx.miembroLiga.create({
        data: { ligaId: liga.id, usuarioId, presupuestoRestante: liga.presupuestoInicial },
      })
      await asignarJugadoresIniciales(nuevo.id, liga.id, liga.division, tx)
      return nuevo
    })

    res.status(201).json(miembro)
  } catch (e: any) {
    if (e?.code === 'P2002') {
      res.status(409).json({ error: 'Ya eres miembro de esta liga' })
      return
    }
    res.status(500).json({ error: e.message ?? 'Error al unirse a la liga' })
  }
}

// ─── LISTAR LIGAS PÚBLICAS ─────────────────────────

export const getLigasPublicas = async (_req: Request, res: Response) => {
  try {
    const ligas = await prisma.liga.findMany({
      where: { publica: true },
      include: { _count: { select: { miembros: true } } },
      orderBy: { creadoEn: 'desc' },
    }) as LigaConConteo[]

    res.json(ligas)
  } catch {
    res.status(500).json({ error: 'Error al obtener ligas' })
  }
}

// ─── MIS LIGAS ─────────────────────────────────────

export const getMisLigas = async (req: AuthRequest, res: Response) => {
  const usuarioId = req.usuarioId!

  try {
    const membresias = await prisma.miembroLiga.findMany({
      where: { usuarioId },
      include: {
        liga: { include: { _count: { select: { miembros: true } } } },
      },
    })

    res.json(membresias)
  } catch {
    res.status(500).json({ error: 'Error al obtener tus ligas' })
  }
}

// ─── DETALLE DE UNA LIGA ───────────────────────────

export const getLiga = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const liga = await prisma.liga.findUnique({
      where: { id: ligaId },
      include: {
        miembros: {
          where: { usuario: { activo: true } },
          include: { usuario: { select: { id: true, username: true } } },
          orderBy: { puntuacion: 'desc' },
        },
      },
    }) as LigaDetalle | null

    if (!liga) {
      res.status(404).json({ error: 'Liga no encontrada' })
      return
    }

    const esMiembro = liga.miembros.some(m => m.usuarioId === usuarioId)
    if (!esMiembro && !liga.publica) {
      res.status(403).json({ error: 'No tienes acceso a esta liga' })
      return
    }

    const miembrosPublicos = liga.miembros.map(m => {
      if (m.usuarioId === usuarioId) return m
      const { presupuestoRestante: _, ...sinPresupuesto } = m
      return sinPresupuesto
    })

    if (!esMiembro) {
      const { codigoInvitacion: __, ...ligaSinCodigo } = liga
      res.json({ ...ligaSinCodigo, miembros: miembrosPublicos })
      return
    }

    res.json({ ...liga, miembros: miembrosPublicos })
  } catch {
    res.status(500).json({ error: 'Error al obtener la liga' })
  }
}

// ─── MI EQUIPO ─────────────────────────────────────

export const getMiEquipo = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await prisma.miembroLiga.findUnique({
      where: { ligaId_usuarioId: { ligaId, usuarioId } },
    })

    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const jugadores = await prisma.plantillaFantasy.findMany({
      where: { miembroLigaId: miembro.id },
      include: {
        jugador: {
          include: {
            historialEquipos: { where: { activo: true }, include: { equipo: true }, take: 1 },
          },
        },
      },
    })

    res.json(jugadores)
  } catch {
    res.status(500).json({ error: 'Error al obtener tu equipo' })
  }
}

// ─── JUGADORES DISPONIBLES (sin dueño en esta liga) ─

export const getJugadoresDisponibles = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const liga = await prisma.liga.findUnique({ where: { id: ligaId } })
    if (!liga) {
      res.status(404).json({ error: 'Liga no encontrada' })
      return
    }

    const miembro = await prisma.miembroLiga.findUnique({
      where: { ligaId_usuarioId: { ligaId, usuarioId } },
    })
    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const asignados = await prisma.plantillaFantasy.findMany({
      where: { ligaId },
      select: { jugadorId: true },
    })
    const idsAsignados = asignados.map(pf => pf.jugadorId)

    const disponibles = await prisma.jugador.findMany({
      where: {
        id: { notIn: idsAsignados },
        historialEquipos: { some: { activo: true, equipo: { division: liga.division } } },
      },
      include: {
        historialEquipos: { where: { activo: true }, include: { equipo: true }, take: 1 },
      },
      orderBy: { valor: 'desc' },
    })

    res.json(disponibles)
  } catch {
    res.status(500).json({ error: 'Error al obtener jugadores disponibles' })
  }
}

// ─── ÚLTIMA JORNADA STATS (para listas de jugadores) ─

export const getUltimaJornadaStats = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string

  try {
    const liga = await prisma.liga.findUnique({ where: { id: ligaId } })
    if (!liga) { res.status(404).json({ error: 'Liga no encontrada' }); return }

    const ultimaJornada = await prisma.jornada.findFirst({
      where: { division: liga.division, estadisticas: { some: {} } },
      orderBy: { numJornada: 'desc' },
    })

    if (!ultimaJornada) { res.json({ jornada: null, stats: {} }); return }

    const estadisticas = await prisma.estadisticaJornada.findMany({
      where: { jornadaId: ultimaJornada.id },
      include: { jugadorEquipo: { select: { jugadorId: true } } },
    })

    const stats: Record<string, object> = {}
    for (const e of estadisticas) {
      stats[e.jugadorEquipo.jugadorId] = {
        puntos: e.puntosCalculados,
        convocado: e.convocado,
        titular: e.titular,
        minutosJugados: e.minutosJugados,
        goles: e.goles,
        resultado: e.resultado,
      }
    }

    res.json({ jornada: { id: ultimaJornada.id, numJornada: ultimaJornada.numJornada }, stats })
  } catch {
    res.status(500).json({ error: 'Error al obtener stats' })
  }
}

// ─── HISTORIAL DE ALINEACIONES ─────────────────────

export const getHistorialAlineaciones = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await prisma.miembroLiga.findUnique({
      where: { ligaId_usuarioId: { ligaId, usuarioId } },
    })
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const jornadas = await prisma.jornada.findMany({
      where: { snapshots: { some: { miembroLigaId: miembro.id } } },
      orderBy: { numJornada: 'desc' },
    })

    const POS_ORDER = ['PORTERO', 'DEFENSA', 'CENTROCAMPISTA', 'DELANTERO', 'UNKNOWN']

    const historial = await Promise.all(jornadas.map(async jornada => {
      const [snaps, puntuacion] = await Promise.all([
        prisma.snapshotAlineacion.findMany({
          where: { jornadaId: jornada.id, miembroLigaId: miembro.id },
          include: {
            jugadorEquipo: {
              include: {
                jugador: true,
                estadisticas: { where: { jornadaId: jornada.id } },
              },
            },
          },
        }),
        prisma.puntuacionJornada.findUnique({
          where: { jornadaId_miembroLigaId: { jornadaId: jornada.id, miembroLigaId: miembro.id } },
        }),
      ])

      const jugadores = snaps
        .map(s => {
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
            estadistica: stats
              ? {
                  convocado: stats.convocado, titular: stats.titular,
                  minutosJugados: stats.minutosJugados, goles: stats.goles,
                  tarjetasAmarillas: stats.tarjetasAmarillas, tarjetaRoja: stats.tarjetaRoja,
                  resultado: stats.resultado, desglose: stats.desglose,
                }
              : null,
            puntos,
          }
        })
        .sort((a, b) => POS_ORDER.indexOf(a.jugador.posicion) - POS_ORDER.indexOf(b.jugador.posicion))

      return {
        jornada: { id: jornada.id, numJornada: jornada.numJornada, fechaCierre: jornada.fechaCierre },
        totalPuntos: puntuacion?.puntos ?? null,
        jugadores,
      }
    }))

    res.json(historial)
  } catch {
    res.status(500).json({ error: 'Error al obtener historial' })
  }
}

// ─── FORMACIONES VÁLIDAS ───────────────────────────

const SLOTS_FORMACION: Record<string, Record<string, number>> = {
  '4-3-3': { PORTERO: 1, DEFENSA: 4, CENTROCAMPISTA: 3, DELANTERO: 3 },
  '3-4-3': { PORTERO: 1, DEFENSA: 3, CENTROCAMPISTA: 4, DELANTERO: 3 },
  '4-4-2': { PORTERO: 1, DEFENSA: 4, CENTROCAMPISTA: 4, DELANTERO: 2 },
}

// ─── GET MI ALINEACIÓN ─────────────────────────────

export const getAlineacion = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await prisma.miembroLiga.findUnique({
      where: { ligaId_usuarioId: { ligaId, usuarioId } },
    })

    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const titulares = await prisma.titularLiga.findMany({
      where: { miembroLigaId: miembro.id },
      select: { jugadorId: true },
    })

    res.json({
      formacion: miembro.formacion ?? '4-3-3',
      titularIds: titulares.map(t => t.jugadorId),
      capitanId: miembro.capitanId ?? null,
    })
  } catch {
    res.status(500).json({ error: 'Error al obtener la alineación' })
  }
}

// ─── GUARDAR MI ALINEACIÓN ─────────────────────────

export const guardarAlineacion = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string
  const usuarioId = req.usuarioId!
  const { formacion, jugadorIds, capitanId } = req.body

  if (!SLOTS_FORMACION[formacion]) {
    res.status(400).json({ error: 'Formación no válida. Usa 4-3-3, 3-4-3 o 4-4-2' })
    return
  }

  if (!Array.isArray(jugadorIds) || jugadorIds.length !== 11) {
    res.status(400).json({ error: 'Debes seleccionar exactamente 11 jugadores' })
    return
  }

  try {
    const miembro = await prisma.miembroLiga.findUnique({
      where: { ligaId_usuarioId: { ligaId, usuarioId } },
    })

    if (!miembro) {
      res.status(403).json({ error: 'No eres miembro de esta liga' })
      return
    }

    const miEquipo = await prisma.plantillaFantasy.findMany({
      where: { miembroLigaId: miembro.id },
      include: { jugador: true },
    })
    const misIds = new Set(miEquipo.map(pf => pf.jugadorId))

    for (const id of jugadorIds) {
      if (!misIds.has(id)) {
        res.status(400).json({ error: 'Uno o más jugadores no pertenecen a tu equipo' })
        return
      }
    }

    const slots = SLOTS_FORMACION[formacion]
    const conteo: Record<string, number> = {}
    for (const id of jugadorIds) {
      const pf = miEquipo.find(pf => pf.jugadorId === id)!
      const pos = pf.jugador.posicion
      conteo[pos] = (conteo[pos] ?? 0) + 1
    }

    for (const [pos, max] of Object.entries(slots)) {
      if ((conteo[pos] ?? 0) !== max) {
        res.status(400).json({
          error: `La formación ${formacion} requiere ${max} ${pos.toLowerCase()}(s), pero has seleccionado ${conteo[pos] ?? 0}`,
        })
        return
      }
    }

    if (capitanId && !jugadorIds.includes(capitanId)) {
      res.status(400).json({ error: 'El capitán debe ser uno de los 11 titulares' })
      return
    }

    await prisma.$transaction(async tx => {
      await tx.titularLiga.deleteMany({ where: { miembroLigaId: miembro.id } })
      await tx.titularLiga.createMany({
        data: jugadorIds.map(jugadorId => ({ miembroLigaId: miembro.id, jugadorId })),
      })
      await tx.miembroLiga.update({
        where: { id: miembro.id },
        data: { formacion, capitanId: capitanId ?? null },
      })
    })

    res.json({ mensaje: 'Alineación guardada', formacion, titulares: jugadorIds.length, capitanId: capitanId ?? null })
  } catch {
    res.status(500).json({ error: 'Error al guardar la alineación' })
  }
}
