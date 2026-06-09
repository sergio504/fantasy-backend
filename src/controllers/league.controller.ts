import { randomUUID } from 'crypto'
import { Request, Response } from 'express'
import { eq, and, notInArray, inArray, count, desc, exists } from 'drizzle-orm'
import { db } from '../db'
import {
  liga, miembroLiga, jugador, jugadorEquipo, equipo,
  plantillaFantasy, titularLiga, snapshotAlineacion, jornada,
  estadisticaJornada, puntuacionJornada,
  Division, Posicion,
} from '../db/schema'
import { AuthRequest } from '../middleware/auth.middleware'
import crypto from 'crypto'

// ─── HELPER: asignar 16 jugadores aleatorios al unirse ─

const CUPOS: Record<Posicion, number> = {
  PORTERO: 2, DEFENSA: 5, CENTROCAMPISTA: 5, DELANTERO: 4, UNKNOWN: 0,
}

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

export async function asignarJugadoresIniciales(
  miembroLigaId: string,
  ligaId: string,
  division: Division,
  tx: typeof db
) {
  const ocupados   = await tx.select({ jugadorId: plantillaFantasy.jugadorId }).from(plantillaFantasy).where(eq(plantillaFantasy.ligaId, ligaId))
  const idsOcupados = ocupados.map(p => p.jugadorId)

  const posiciones = (Object.keys(CUPOS) as Posicion[]).filter(p => CUPOS[p] > 0)
  const lotes = await Promise.all(
    posiciones.map(pos =>
      tx.selectDistinct({ id: jugador.id, valor: jugador.valor })
        .from(jugador)
        .innerJoin(jugadorEquipo, and(eq(jugadorEquipo.jugadorId, jugador.id), eq(jugadorEquipo.activo, true)))
        .innerJoin(equipo, and(eq(equipo.id, jugadorEquipo.equipoId), eq(equipo.division, division)))
        .where(and(eq(jugador.posicion, pos), idsOcupados.length > 0 ? notInArray(jugador.id, idsOcupados) : undefined))
    )
  )

  const seleccionados = posiciones.flatMap((pos, i) => shuffle(lotes[i]).slice(0, CUPOS[pos]))
  if (seleccionados.length < 16) throw new Error(`No hay suficientes jugadores libres en la división ${division}`)

  await tx.insert(plantillaFantasy).values(
    seleccionados.map(j => ({ id: randomUUID(), ligaId, miembroLigaId, jugadorId: j.id, precioCompra: j.valor, creadoEn: new Date() }))
  )
}

// ─── CREAR LIGA ────────────────────────────────────

export const crearLiga = async (req: AuthRequest, res: Response) => {
  const { nombre, division, publica, maxEquipos, presupuestoInicial } = req.body
  const creadorId = req.usuarioId!

  if (!nombre || !division) { res.status(400).json({ error: 'nombre y division son obligatorios' }); return }
  const divisiones: Division[] = ['RFEF2_GRUPO_II', 'RFEF3_GRUPO_IV', 'HONOR_BIZKAIA']
  if (!divisiones.includes(division)) {
    res.status(400).json({ error: `division debe ser uno de: ${divisiones.join(', ')}` }); return
  }

  try {
    const esPublica        = publica !== false
    const codigoInvitacion = esPublica ? null : crypto.randomBytes(6).toString('hex')
    const presupuesto      = presupuestoInicial ?? 100
    const ligaId           = randomUUID()
    const miembroId        = randomUUID()
    const now              = new Date()

    const ligaCreada = await db.transaction(async tx => {
      await tx.insert(liga).values({ id: ligaId, nombre, creadorId, division, publica: esPublica, codigoInvitacion, maxEquipos: maxEquipos ?? 10, presupuestoInicial: presupuesto, creadoEn: now })
      await tx.insert(miembroLiga).values({ id: miembroId, ligaId, usuarioId: creadorId, presupuestoRestante: presupuesto, creadoEn: now })
      await asignarJugadoresIniciales(miembroId, ligaId, division, tx as any)
      return tx.query.liga.findFirst({ where: eq(liga.id, ligaId), with: { miembros: true } })
    })
    res.status(201).json(ligaCreada)
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? 'Error al crear la liga' })
  }
}

// ─── UNIRSE A LIGA PÚBLICA ─────────────────────────

export const unirseALiga = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const ligaData = await db.query.liga.findFirst({ where: eq(liga.id, ligaId) })
    if (!ligaData)         { res.status(404).json({ error: 'Liga no encontrada' }); return }
    if (!ligaData.publica) { res.status(403).json({ error: 'Liga privada: usa el código de invitación' }); return }

    const [{ total: numMiembros }] = await db.select({ total: count() }).from(miembroLiga).where(eq(miembroLiga.ligaId, ligaId))
    if (numMiembros >= ligaData.maxEquipos) { res.status(409).json({ error: 'La liga está llena' }); return }

    const miembroId = randomUUID()
    const miembro = await db.transaction(async tx => {
      await tx.insert(miembroLiga).values({ id: miembroId, ligaId, usuarioId, presupuestoRestante: ligaData.presupuestoInicial, creadoEn: new Date() })
      await asignarJugadoresIniciales(miembroId, ligaId, ligaData.division, tx as any)
      const [m] = await tx.select().from(miembroLiga).where(eq(miembroLiga.id, miembroId)).limit(1)
      return m
    })
    res.status(201).json(miembro)
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') { res.status(409).json({ error: 'Ya eres miembro de esta liga' }); return }
    res.status(500).json({ error: e.message ?? 'Error al unirse a la liga' })
  }
}

// ─── UNIRSE A LIGA PRIVADA ─────────────────────────

export const unirseConCodigo = async (req: AuthRequest, res: Response) => {
  const { codigo } = req.body
  const usuarioId  = req.usuarioId!
  if (!codigo) { res.status(400).json({ error: 'codigo es obligatorio' }); return }

  try {
    const [ligaData] = await db.select().from(liga).where(eq(liga.codigoInvitacion, codigo)).limit(1)
    if (!ligaData) { res.status(404).json({ error: 'Código de invitación no válido' }); return }

    const [{ total: numMiembros }] = await db.select({ total: count() }).from(miembroLiga).where(eq(miembroLiga.ligaId, ligaData.id))
    if (numMiembros >= ligaData.maxEquipos) { res.status(409).json({ error: 'La liga está llena' }); return }

    const miembroId = randomUUID()
    const miembro = await db.transaction(async tx => {
      await tx.insert(miembroLiga).values({ id: miembroId, ligaId: ligaData.id, usuarioId, presupuestoRestante: ligaData.presupuestoInicial, creadoEn: new Date() })
      await asignarJugadoresIniciales(miembroId, ligaData.id, ligaData.division, tx as any)
      const [m] = await tx.select().from(miembroLiga).where(eq(miembroLiga.id, miembroId)).limit(1)
      return m
    })
    res.status(201).json(miembro)
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') { res.status(409).json({ error: 'Ya eres miembro de esta liga' }); return }
    res.status(500).json({ error: e.message ?? 'Error al unirse a la liga' })
  }
}

// ─── LISTAR LIGAS PÚBLICAS ─────────────────────────

export const getLigasPublicas = async (_req: Request, res: Response) => {
  try {
    const rawLigas = await db
      .select({ id: liga.id, nombre: liga.nombre, division: liga.division, publica: liga.publica,
                codigoInvitacion: liga.codigoInvitacion, maxEquipos: liga.maxEquipos,
                presupuestoInicial: liga.presupuestoInicial, creadoEn: liga.creadoEn,
                creadorId: liga.creadorId, numMiembros: count(miembroLiga.id) })
      .from(liga).leftJoin(miembroLiga, eq(miembroLiga.ligaId, liga.id))
      .where(eq(liga.publica, true)).groupBy(liga.id).orderBy(desc(liga.creadoEn))

    res.json(rawLigas.map(({ numMiembros, ...rest }) => ({ ...rest, _count: { miembros: numMiembros } })))
  } catch {
    res.status(500).json({ error: 'Error al obtener ligas' })
  }
}

// ─── MIS LIGAS ─────────────────────────────────────

export const getMisLigas = async (req: AuthRequest, res: Response) => {
  const usuarioId = req.usuarioId!
  try {
    const membresias = await db.query.miembroLiga.findMany({ where: eq(miembroLiga.usuarioId, usuarioId), with: { liga: true } })
    const ligaIds    = membresias.map(m => m.ligaId)
    const countMap   = new Map<string, number>()
    if (ligaIds.length > 0) {
      const counts = await db.select({ ligaId: miembroLiga.ligaId, total: count() })
        .from(miembroLiga).where(inArray(miembroLiga.ligaId, ligaIds)).groupBy(miembroLiga.ligaId)
      counts.forEach(c => countMap.set(c.ligaId, c.total))
    }
    res.json(membresias.map(m => ({ ...m, liga: { ...m.liga, _count: { miembros: countMap.get(m.ligaId) ?? 0 } } })))
  } catch {
    res.status(500).json({ error: 'Error al obtener tus ligas' })
  }
}

// ─── DETALLE DE UNA LIGA ───────────────────────────

export const getLiga = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const ligaData = await db.query.liga.findFirst({
      where: eq(liga.id, ligaId),
      with:  { miembros: { orderBy: desc(miembroLiga.puntuacion), with: { usuario: { columns: { id: true, username: true, activo: true } } } } },
    })
    if (!ligaData) { res.status(404).json({ error: 'Liga no encontrada' }); return }

    const miembrosActivos = ligaData.miembros.filter(m => m.usuario.activo)
    const esMiembro       = miembrosActivos.some(m => m.usuarioId === usuarioId)

    if (!esMiembro && !ligaData.publica) { res.status(403).json({ error: 'No tienes acceso a esta liga' }); return }

    const miembrosPublicos = miembrosActivos.map(m => {
      const { activo: _a, ...usr } = m.usuario
      if (m.usuarioId === usuarioId) return { ...m, usuario: usr }
      const { presupuestoRestante: _, ...sinPresupuesto } = m
      return { ...sinPresupuesto, usuario: usr }
    })

    if (!esMiembro) {
      const { codigoInvitacion: _, ...ligaSinCodigo } = ligaData
      res.json({ ...ligaSinCodigo, miembros: miembrosPublicos }); return
    }
    res.json({ ...ligaData, miembros: miembrosPublicos })
  } catch {
    res.status(500).json({ error: 'Error al obtener la liga' })
  }
}

// ─── MI EQUIPO ─────────────────────────────────────

export const getMiEquipo = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await db.query.miembroLiga.findFirst({ where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)) })
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const jugadores = await db.query.plantillaFantasy.findMany({
      where: eq(plantillaFantasy.miembroLigaId, miembro.id),
      with:  { jugador: { with: { historialEquipos: { where: eq(jugadorEquipo.activo, true), limit: 1, with: { equipo: true } } } } },
    })
    res.json(jugadores)
  } catch {
    res.status(500).json({ error: 'Error al obtener tu equipo' })
  }
}

// ─── JUGADORES DISPONIBLES ─────────────────────────

export const getJugadoresDisponibles = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const ligaData = await db.query.liga.findFirst({ where: eq(liga.id, ligaId) })
    if (!ligaData) { res.status(404).json({ error: 'Liga no encontrada' }); return }

    const miembro = await db.query.miembroLiga.findFirst({ where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)) })
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const asignados   = await db.select({ jugadorId: plantillaFantasy.jugadorId }).from(plantillaFantasy).where(eq(plantillaFantasy.ligaId, ligaId))
    const idsAsignados = asignados.map(p => p.jugadorId)

    const disponibleIds = await db.selectDistinct({ id: jugador.id }).from(jugador)
      .innerJoin(jugadorEquipo, and(eq(jugadorEquipo.jugadorId, jugador.id), eq(jugadorEquipo.activo, true)))
      .innerJoin(equipo, and(eq(equipo.id, jugadorEquipo.equipoId), eq(equipo.division, ligaData.division)))
      .where(idsAsignados.length > 0 ? notInArray(jugador.id, idsAsignados) : undefined)

    const ids = disponibleIds.map(r => r.id)
    if (ids.length === 0) { res.json([]); return }

    const disponibles = await db.query.jugador.findMany({
      where:   inArray(jugador.id, ids),
      orderBy: desc(jugador.valor),
      with:    { historialEquipos: { where: eq(jugadorEquipo.activo, true), limit: 1, with: { equipo: true } } },
    })
    res.json(disponibles)
  } catch {
    res.status(500).json({ error: 'Error al obtener jugadores disponibles' })
  }
}

// ─── ÚLTIMA JORNADA STATS ──────────────────────────

export const getUltimaJornadaStats = async (req: AuthRequest, res: Response) => {
  const ligaId = req.params.ligaId as string

  try {
    const ligaData = await db.query.liga.findFirst({ where: eq(liga.id, ligaId) })
    if (!ligaData) { res.status(404).json({ error: 'Liga no encontrada' }); return }

    const ultimaJornada = await db.query.jornada.findFirst({
      where:   and(eq(jornada.division, ligaData.division), exists(db.select({ id: estadisticaJornada.id }).from(estadisticaJornada).where(eq(estadisticaJornada.jornadaId, jornada.id)).limit(1))),
      orderBy: desc(jornada.numJornada),
    })
    if (!ultimaJornada) { res.json({ jornada: null, stats: {} }); return }

    const estadisticas = await db.query.estadisticaJornada.findMany({
      where: eq(estadisticaJornada.jornadaId, ultimaJornada.id),
      with:  { jugadorEquipo: { columns: { jugadorId: true } } },
    })

    const stats: Record<string, object> = {}
    for (const e of estadisticas) {
      stats[e.jugadorEquipo.jugadorId] = {
        puntos: e.puntosCalculados, convocado: e.convocado, titular: e.titular,
        minutosJugados: e.minutosJugados, goles: e.goles, resultado: e.resultado,
      }
    }
    res.json({ jornada: { id: ultimaJornada.id, numJornada: ultimaJornada.numJornada }, stats })
  } catch {
    res.status(500).json({ error: 'Error al obtener stats' })
  }
}

// ─── HISTORIAL DE ALINEACIONES ─────────────────────

export const getHistorialAlineaciones = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await db.query.miembroLiga.findFirst({ where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)) })
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const jornadaIds = await db.selectDistinct({ jornadaId: snapshotAlineacion.jornadaId })
      .from(snapshotAlineacion).where(eq(snapshotAlineacion.miembroLigaId, miembro.id))
    if (jornadaIds.length === 0) { res.json([]); return }

    const POS_ORDER = ['PORTERO', 'DEFENSA', 'CENTROCAMPISTA', 'DELANTERO', 'UNKNOWN']
    const jornadas  = await db.query.jornada.findMany({
      where:   inArray(jornada.id, jornadaIds.map(r => r.jornadaId)),
      orderBy: desc(jornada.numJornada),
    })

    const historial = await Promise.all(jornadas.map(async j => {
      const [snaps, puntuacion] = await Promise.all([
        db.query.snapshotAlineacion.findMany({
          where: and(eq(snapshotAlineacion.jornadaId, j.id), eq(snapshotAlineacion.miembroLigaId, miembro.id)),
          with:  {
            jugadorEquipo: {
              with: {
                jugador: true,
                estadisticas: { where: eq(estadisticaJornada.jornadaId, j.id) },
              },
            },
          },
        }),
        db.query.puntuacionJornada.findFirst({
          where: and(eq(puntuacionJornada.jornadaId, j.id), eq(puntuacionJornada.miembroLigaId, miembro.id)),
        }),
      ])

      const jugadoresSnap = snaps
        .map(s => {
          const stats  = s.jugadorEquipo.estadisticas[0] ?? null
          const puntos = stats ? (s.esCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados) : null
          return {
            jugador:     { nombreCompleto: s.jugadorEquipo.jugador.nombreCompleto, posicion: s.jugadorEquipo.jugador.posicion },
            esCapitan:   s.esCapitan,
            estadistica: stats ? { convocado: stats.convocado, titular: stats.titular, minutosJugados: stats.minutosJugados, goles: stats.goles, tarjetasAmarillas: stats.tarjetasAmarillas, tarjetaRoja: stats.tarjetaRoja, resultado: stats.resultado, desglose: stats.desglose } : null,
            puntos,
          }
        })
        .sort((a, b) => POS_ORDER.indexOf(a.jugador.posicion) - POS_ORDER.indexOf(b.jugador.posicion))

      return {
        jornada:     { id: j.id, numJornada: j.numJornada, fechaCierre: j.fechaCierre },
        totalPuntos: puntuacion?.puntos ?? null,
        jugadores:   jugadoresSnap,
      }
    }))
    res.json(historial)
  } catch {
    res.status(500).json({ error: 'Error al obtener historial' })
  }
}

// ─── ALINEACIÓN ────────────────────────────────────

const SLOTS_FORMACION: Record<string, Record<string, number>> = {
  '4-3-3': { PORTERO: 1, DEFENSA: 4, CENTROCAMPISTA: 3, DELANTERO: 3 },
  '3-4-3': { PORTERO: 1, DEFENSA: 3, CENTROCAMPISTA: 4, DELANTERO: 3 },
  '4-4-2': { PORTERO: 1, DEFENSA: 4, CENTROCAMPISTA: 4, DELANTERO: 2 },
}

export const getAlineacion = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await db.query.miembroLiga.findFirst({ where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)) })
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const titulares = await db.select({ jugadorId: titularLiga.jugadorId }).from(titularLiga).where(eq(titularLiga.miembroLigaId, miembro.id))
    res.json({ formacion: miembro.formacion ?? '4-3-3', titularIds: titulares.map(t => t.jugadorId), capitanId: miembro.capitanId ?? null })
  } catch {
    res.status(500).json({ error: 'Error al obtener la alineación' })
  }
}

export const guardarAlineacion = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!
  const { formacion, jugadorIds, capitanId } = req.body

  if (!SLOTS_FORMACION[formacion])                          { res.status(400).json({ error: 'Formación no válida. Usa 4-3-3, 3-4-3 o 4-4-2' }); return }
  if (!Array.isArray(jugadorIds) || jugadorIds.length !== 11) { res.status(400).json({ error: 'Debes seleccionar exactamente 11 jugadores' }); return }

  try {
    const miembro = await db.query.miembroLiga.findFirst({ where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)) })
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const miEquipo = await db.query.plantillaFantasy.findMany({ where: eq(plantillaFantasy.miembroLigaId, miembro.id), with: { jugador: true } })
    const misIds   = new Set(miEquipo.map(pf => pf.jugadorId))
    for (const id of jugadorIds) {
      if (!misIds.has(id)) { res.status(400).json({ error: 'Uno o más jugadores no pertenecen a tu equipo' }); return }
    }

    const slots  = SLOTS_FORMACION[formacion]
    const conteo: Record<string, number> = {}
    for (const id of jugadorIds) {
      const pos = miEquipo.find(pf => pf.jugadorId === id)!.jugador.posicion
      conteo[pos] = (conteo[pos] ?? 0) + 1
    }
    for (const [pos, max] of Object.entries(slots)) {
      if ((conteo[pos] ?? 0) !== max) {
        res.status(400).json({ error: `La formación ${formacion} requiere ${max} ${pos.toLowerCase()}(s), pero has seleccionado ${conteo[pos] ?? 0}` }); return
      }
    }
    if (capitanId && !jugadorIds.includes(capitanId)) { res.status(400).json({ error: 'El capitán debe ser uno de los 11 titulares' }); return }

    await db.transaction(async tx => {
      await tx.delete(titularLiga).where(eq(titularLiga.miembroLigaId, miembro.id))
      await tx.insert(titularLiga).values(jugadorIds.map(jugadorId => ({ id: randomUUID(), miembroLigaId: miembro.id, jugadorId })))
      await tx.update(miembroLiga).set({ formacion, capitanId: capitanId ?? null }).where(eq(miembroLiga.id, miembro.id))
    })
    res.json({ mensaje: 'Alineación guardada', formacion, titulares: jugadorIds.length, capitanId: capitanId ?? null })
  } catch {
    res.status(500).json({ error: 'Error al guardar la alineación' })
  }
}
