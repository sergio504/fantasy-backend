import { randomUUID } from 'crypto'
import { Request, Response } from 'express'
import { eq, and, notInArray, inArray, count, desc, asc, lte, gte, sum, exists, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  liga, miembroLiga, jugador, jugadorEquipo, equipo, usuario,
  plantillaFantasy, titularLiga, snapshotAlineacion, jornada,
  estadisticaJornada, puntuacionJornada, clausulazoPendiente,
  historialSaldo,
  Division, Posicion,
} from '../db/schema'
import { AuthRequest } from '../middleware/auth.middleware'
import { registrarMovimientoSaldo, registrarCambioClausula } from '../lib/historial'
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
    seleccionados.map(j => ({ id: randomUUID(), ligaId, miembroLigaId, jugadorId: j.id, precioCompra: j.valor, clausula: j.valor * 2, jornadasBloqueo: 3, creadoEn: new Date() }))
  )

  // Historial de cláusula inicial por cada jugador asignado
  for (const j of seleccionados) {
    await registrarCambioClausula(tx, {
      jugadorId: j.id, ligaId, miembroLigaId,
      clausulaAnterior: 0, clausulaNueva: j.valor * 2, motivo: 'ADQUISICION',
    })
  }
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
      await registrarMovimientoSaldo(tx, { miembroLigaId: miembroId, ligaId, concepto: 'PRESUPUESTO_INICIAL', importe: presupuesto, saldoResultante: presupuesto, descripcion: `Presupuesto inicial de la liga` })
      await asignarJugadoresIniciales(miembroId, ligaId, division, tx as any)
      const [l] = await tx.select().from(liga).where(eq(liga.id, ligaId)).limit(1)
      const miembros = await tx.select().from(miembroLiga).where(eq(miembroLiga.ligaId, ligaId))
      return { ...l!, miembros }
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
      await registrarMovimientoSaldo(tx, { miembroLigaId: miembroId, ligaId, concepto: 'PRESUPUESTO_INICIAL', importe: ligaData.presupuestoInicial, saldoResultante: ligaData.presupuestoInicial, descripcion: `Presupuesto inicial de la liga` })
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
      await registrarMovimientoSaldo(tx, { miembroLigaId: miembroId, ligaId: ligaData.id, concepto: 'PRESUPUESTO_INICIAL', importe: ligaData.presupuestoInicial, saldoResultante: ligaData.presupuestoInicial, descripcion: `Presupuesto inicial de la liga` })
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
    const membresiasRaw = await db.select().from(miembroLiga).where(eq(miembroLiga.usuarioId, usuarioId))
    const ligaIds       = membresiasRaw.map(m => m.ligaId)
    if (ligaIds.length === 0) { res.json([]); return }

    const [ligasRaw, counts] = await Promise.all([
      db.select().from(liga).where(inArray(liga.id, ligaIds)),
      db.select({ ligaId: miembroLiga.ligaId, total: count() })
        .from(miembroLiga).where(inArray(miembroLiga.ligaId, ligaIds)).groupBy(miembroLiga.ligaId),
    ])
    const ligaMap  = new Map(ligasRaw.map(l => [l.id, l]))
    const countMap = new Map(counts.map(c => [c.ligaId, c.total]))
    res.json(membresiasRaw.map(m => ({ ...m, liga: { ...ligaMap.get(m.ligaId)!, _count: { miembros: countMap.get(m.ligaId) ?? 0 } } })))
  } catch {
    res.status(500).json({ error: 'Error al obtener tus ligas' })
  }
}

// ─── DETALLE DE UNA LIGA ───────────────────────────

export const getLiga = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const [ligaData] = await db.select().from(liga).where(eq(liga.id, ligaId)).limit(1)
    if (!ligaData) { res.status(404).json({ error: 'Liga no encontrada' }); return }

    const miembrosRaw = await db
      .select({
        id: miembroLiga.id, ligaId: miembroLiga.ligaId, usuarioId: miembroLiga.usuarioId,
        presupuestoRestante: miembroLiga.presupuestoRestante, puntuacion: miembroLiga.puntuacion,
        formacion: miembroLiga.formacion, capitanId: miembroLiga.capitanId, creadoEn: miembroLiga.creadoEn,
        uId: usuario.id, uUsername: usuario.username, uActivo: usuario.activo,
      })
      .from(miembroLiga)
      .innerJoin(usuario, eq(usuario.id, miembroLiga.usuarioId))
      .where(eq(miembroLiga.ligaId, ligaId))
      .orderBy(desc(miembroLiga.puntuacion))

    const miembros = miembrosRaw.map(m => ({
      id: m.id, ligaId: m.ligaId, usuarioId: m.usuarioId,
      presupuestoRestante: m.presupuestoRestante, puntuacion: m.puntuacion,
      formacion: m.formacion, capitanId: m.capitanId, creadoEn: m.creadoEn,
      usuario: { id: m.uId, username: m.uUsername, activo: m.uActivo },
    }))

    const miembrosActivos = miembros.filter(m => m.usuario.activo)
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

    const plantillaRaw = await db
      .select({
        pfId: plantillaFantasy.id, pfLigaId: plantillaFantasy.ligaId,
        pfMiembroLigaId: plantillaFantasy.miembroLigaId, pfJugadorId: plantillaFantasy.jugadorId,
        pfPrecioCompra: plantillaFantasy.precioCompra, pfCreadoEn: plantillaFantasy.creadoEn,
        pfClausula: plantillaFantasy.clausula, pfJornadasBloqueo: plantillaFantasy.jornadasBloqueo,
        jId: jugador.id, jNombreCompleto: jugador.nombreCompleto, jNombre: jugador.nombre,
        jDorsal: jugador.dorsal, jFechaNacimiento: jugador.fechaNacimiento, jEdad: jugador.edad,
        jPosicion: jugador.posicion, jValor: jugador.valor, jCreadoEn: jugador.creadoEn,
      })
      .from(plantillaFantasy)
      .innerJoin(jugador, eq(jugador.id, plantillaFantasy.jugadorId))
      .where(eq(plantillaFantasy.miembroLigaId, miembro.id))

    const jugadorIds = plantillaRaw.map(p => p.pfJugadorId)
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

    const [titularesSet, pendientesClausulazo] = await Promise.all([
      jugadorIds.length > 0
        ? db.select({ jugadorId: titularLiga.jugadorId })
            .from(titularLiga).where(eq(titularLiga.miembroLigaId, miembro.id))
            .then(rows => new Set(rows.map(t => t.jugadorId)))
        : Promise.resolve(new Set<string>()),
      jugadorIds.length > 0
        ? db.select().from(clausulazoPendiente)
            .where(and(eq(clausulazoPendiente.ligaId, ligaId), inArray(clausulazoPendiente.jugadorId, jugadorIds)))
        : Promise.resolve([]),
    ])
    const pendienteSet = new Set(pendientesClausulazo.map(cp => cp.jugadorId))

    res.json(plantillaRaw.map(p => ({
      id: p.pfId, ligaId: p.pfLigaId, miembroLigaId: p.pfMiembroLigaId,
      jugadorId: p.pfJugadorId, precioCompra: p.pfPrecioCompra, creadoEn: p.pfCreadoEn,
      clausula: p.pfClausula, jornadasBloqueo: p.pfJornadasBloqueo,
      clausulazoPendiente: pendienteSet.has(p.pfJugadorId),
      esTitular: titularesSet.has(p.pfJugadorId),
      jugador: {
        id: p.jId, nombreCompleto: p.jNombreCompleto, nombre: p.jNombre,
        dorsal: p.jDorsal, fechaNacimiento: p.jFechaNacimiento, edad: p.jEdad,
        posicion: p.jPosicion, valor: p.jValor, creadoEn: p.jCreadoEn,
        historialEquipos: histMap.has(p.pfJugadorId) ? [histMap.get(p.pfJugadorId)!] : [],
      },
    })))
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

    const jugadores = await db.select().from(jugador)
      .where(inArray(jugador.id, ids))
      .orderBy(desc(jugador.valor))

    const equiposActivos = await db.select({
          jeJugadorId: jugadorEquipo.jugadorId, jeId: jugadorEquipo.id,
          jeEquipoId: jugadorEquipo.equipoId, jeDesde: jugadorEquipo.desde,
          jeHasta: jugadorEquipo.hasta, jeActivo: jugadorEquipo.activo, jeCreadoEn: jugadorEquipo.creadoEn,
          eId: equipo.id, eNombre: equipo.nombre, eDivision: equipo.division, eCreadoEn: equipo.creadoEn,
        })
      .from(jugadorEquipo)
      .innerJoin(equipo, eq(equipo.id, jugadorEquipo.equipoId))
      .where(and(eq(jugadorEquipo.activo, true), inArray(jugadorEquipo.jugadorId, ids)))

    const histMap = new Map(equiposActivos.map(r => [r.jeJugadorId, {
      id: r.jeId, jugadorId: r.jeJugadorId, equipoId: r.jeEquipoId,
      desde: r.jeDesde, hasta: r.jeHasta, activo: r.jeActivo, creadoEn: r.jeCreadoEn,
      equipo: { id: r.eId, nombre: r.eNombre, division: r.eDivision, creadoEn: r.eCreadoEn },
    }]))
    res.json(jugadores.map(j => ({ ...j, historialEquipos: histMap.has(j.id) ? [histMap.get(j.id)!] : [] })))
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

    const todasLasJornadas = await db.query.jornada.findMany({
      where: and(eq(jornada.division, ligaData.division)),
    })
    const jornadaIds = todasLasJornadas.map(j => j.id)

    const estadisticas = await db
      .select({
        jeJugadorId: jugadorEquipo.jugadorId,
        puntosCalculados: estadisticaJornada.puntosCalculados,
        convocado: estadisticaJornada.convocado,
        titular: estadisticaJornada.titular,
        minutosJugados: estadisticaJornada.minutosJugados,
        goles: estadisticaJornada.goles,
        resultado: estadisticaJornada.resultado,
      })
      .from(estadisticaJornada)
      .innerJoin(jugadorEquipo, eq(jugadorEquipo.id, estadisticaJornada.jugadorEquipoId))
      .where(inArray(estadisticaJornada.jornadaId, jornadaIds))

    const stats: Record<string, object> = {}
    for (const e of estadisticas) {
      const existing = stats[e.jeJugadorId] as any
      if (existing) {
        existing.puntos += e.puntosCalculados
        existing.goles  += e.goles
      } else {
        stats[e.jeJugadorId] = {
          puntos: e.puntosCalculados, convocado: e.convocado, titular: e.titular,
          minutosJugados: e.minutosJugados, goles: e.goles, resultado: e.resultado,
        }
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
      const [snapsRaw, puntuacion] = await Promise.all([
        db.select({
            snapId: snapshotAlineacion.id, snapJornadaId: snapshotAlineacion.jornadaId,
            snapMiembroLigaId: snapshotAlineacion.miembroLigaId,
            snapJugadorEquipoId: snapshotAlineacion.jugadorEquipoId,
            snapEsCapitan: snapshotAlineacion.esCapitan, snapCreadoEn: snapshotAlineacion.creadoEn,
            jeId: jugadorEquipo.id,
            jugNombreCompleto: jugador.nombreCompleto, jugNombre: jugador.nombre, jugPosicion: jugador.posicion,
          })
          .from(snapshotAlineacion)
          .innerJoin(jugadorEquipo, eq(jugadorEquipo.id, snapshotAlineacion.jugadorEquipoId))
          .innerJoin(jugador, eq(jugador.id, jugadorEquipo.jugadorId))
          .where(and(eq(snapshotAlineacion.jornadaId, j.id), eq(snapshotAlineacion.miembroLigaId, miembro.id))),
        db.query.puntuacionJornada.findFirst({
          where: and(eq(puntuacionJornada.jornadaId, j.id), eq(puntuacionJornada.miembroLigaId, miembro.id)),
        }),
      ])

      const jeIds = snapsRaw.map(r => r.jeId)
      const statsRows = jeIds.length > 0
        ? await db.select().from(estadisticaJornada)
            .where(and(eq(estadisticaJornada.jornadaId, j.id), inArray(estadisticaJornada.jugadorEquipoId, jeIds)))
        : []
      const statsMap = new Map(statsRows.map(s => [s.jugadorEquipoId, s]))

      const jugadoresSnap = snapsRaw
        .map(r => {
          const stats  = statsMap.get(r.jeId) ?? null
          const puntos = stats ? (r.snapEsCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados) : null
          return {
            jugador:     { nombreCompleto: r.jugNombreCompleto, nombre: r.jugNombre, posicion: r.jugPosicion },
            esCapitan:   r.snapEsCapitan,
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

// ─── HISTORIAL DE ALINEACIONES DE CUALQUIER MIEMBRO ──

export const getHistorialMiembro = async (req: AuthRequest, res: Response) => {
  const { ligaId, miembroId } = req.params as { ligaId: string; miembroId: string }
  const usuarioId = req.usuarioId!

  try {
    // Verificar que el solicitante es miembro de la liga
    const solicitante = await db.query.miembroLiga.findFirst({ where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)) })
    if (!solicitante) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const miembro = await db.query.miembroLiga.findFirst({ where: and(eq(miembroLiga.id, miembroId), eq(miembroLiga.ligaId, ligaId)) })
    if (!miembro) { res.status(404).json({ error: 'Miembro no encontrado' }); return }

    const jornadaIds = await db.selectDistinct({ jornadaId: snapshotAlineacion.jornadaId })
      .from(snapshotAlineacion).where(eq(snapshotAlineacion.miembroLigaId, miembroId))
    if (jornadaIds.length === 0) { res.json([]); return }

    const POS_ORDER = ['PORTERO', 'DEFENSA', 'CENTROCAMPISTA', 'DELANTERO', 'UNKNOWN']
    const jornadas  = await db.query.jornada.findMany({
      where:   inArray(jornada.id, jornadaIds.map(r => r.jornadaId)),
      orderBy: desc(jornada.numJornada),
    })

    const historial = await Promise.all(jornadas.map(async j => {
      const [snapsRaw, puntuacion] = await Promise.all([
        db.select({
            jeId: jugadorEquipo.id,
            jugId: jugador.id,
            jugNombreCompleto: jugador.nombreCompleto, jugNombre: jugador.nombre, jugPosicion: jugador.posicion,
            equipoNombre: equipo.nombre,
            snapEsCapitan: snapshotAlineacion.esCapitan,
          })
          .from(snapshotAlineacion)
          .innerJoin(jugadorEquipo, eq(jugadorEquipo.id, snapshotAlineacion.jugadorEquipoId))
          .innerJoin(jugador, eq(jugador.id, jugadorEquipo.jugadorId))
          .innerJoin(equipo, eq(equipo.id, jugadorEquipo.equipoId))
          .where(and(eq(snapshotAlineacion.jornadaId, j.id), eq(snapshotAlineacion.miembroLigaId, miembroId))),
        db.query.puntuacionJornada.findFirst({
          where: and(eq(puntuacionJornada.jornadaId, j.id), eq(puntuacionJornada.miembroLigaId, miembroId)),
        }),
      ])

      const jeIds = snapsRaw.map(r => r.jeId)
      const statsRows = jeIds.length > 0
        ? await db.select().from(estadisticaJornada)
            .where(and(eq(estadisticaJornada.jornadaId, j.id), inArray(estadisticaJornada.jugadorEquipoId, jeIds)))
        : []
      const statsMap = new Map(statsRows.map(s => [s.jugadorEquipoId, s]))

      const jugadoresSnap = snapsRaw
        .map(r => {
          const stats  = statsMap.get(r.jeId) ?? null
          const puntos = stats ? (r.snapEsCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados) : null
          return {
            jugadorId:    r.jugId,
            jugador:      { nombre: r.jugNombre, nombreCompleto: r.jugNombreCompleto, posicion: r.jugPosicion },
            equipo:       r.equipoNombre,
            esCapitan:    r.snapEsCapitan,
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
    res.status(500).json({ error: 'Error al obtener historial del miembro' })
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

    const miEquipo = await db
      .select({ pfJugadorId: plantillaFantasy.jugadorId, jPosicion: jugador.posicion })
      .from(plantillaFantasy)
      .innerJoin(jugador, eq(jugador.id, plantillaFantasy.jugadorId))
      .where(eq(plantillaFantasy.miembroLigaId, miembro.id))
    const misIds = new Set(miEquipo.map(pf => pf.pfJugadorId))
    for (const id of jugadorIds) {
      if (!misIds.has(id)) { res.status(400).json({ error: 'Uno o más jugadores no pertenecen a tu equipo' }); return }
    }

    const slots  = SLOTS_FORMACION[formacion]
    const conteo: Record<string, number> = {}
    for (const id of jugadorIds) {
      const pos = miEquipo.find(pf => pf.pfJugadorId === id)!.jPosicion
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

// ─── HISTORIAL DE SALDO ────────────────────────────

export const getHistorialSaldo = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await db.query.miembroLiga.findFirst({
      where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)),
    })
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const rows = await db
      .select({
        hs:          historialSaldo,
        jNombre:     jugador.nombre,
      })
      .from(historialSaldo)
      .leftJoin(jugador, eq(jugador.id, historialSaldo.jugadorId))
      .where(eq(historialSaldo.miembroLigaId, miembro.id))
      .orderBy(asc(historialSaldo.creadoEn))

    res.json(rows.map(r => ({
      ...r.hs,
      jugadorNombre: r.jNombre ?? null,
    })))
  } catch {
    res.status(500).json({ error: 'Error al obtener el historial de saldo' })
  }
}

// ─── CLASIFICACIÓN POR JORNADA ─────────────────────

export const getClasificacion = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!
  const { modo, num } = req.query as { modo?: string; num?: string }

  try {
    const [ligaRow] = await db.select().from(liga).where(eq(liga.id, ligaId)).limit(1)
    if (!ligaRow) { res.status(404).json({ error: 'Liga no encontrada' }); return }

    const miembro = await db.query.miembroLiga.findFirst({
      where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)),
    })
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const miembros = await db
      .select({ id: miembroLiga.id, usuarioId: miembroLiga.usuarioId, username: usuario.username, presupuestoRestante: miembroLiga.presupuestoRestante })
      .from(miembroLiga)
      .innerJoin(usuario, eq(usuario.id, miembroLiga.usuarioId))
      .where(eq(miembroLiga.ligaId, ligaId))

    const miembroIds = miembros.map(m => m.id)

    // Función para construir la clasificación a partir de un mapa de puntos
    const buildResult = (puntosMap: Map<string, number>) =>
      miembros
        .map(m => ({ ...m, puntos: puntosMap.get(m.id) ?? 0 }))
        .sort((a, b) => b.puntos - a.puntos)

    if (!modo || modo === 'total') {
      if (miembroIds.length === 0) return res.json([])
      const totales = await db
        .select({ miembroLigaId: puntuacionJornada.miembroLigaId, puntos: sum(puntuacionJornada.puntos) })
        .from(puntuacionJornada)
        .where(inArray(puntuacionJornada.miembroLigaId, miembroIds))
        .groupBy(puntuacionJornada.miembroLigaId)
      return res.json(buildResult(new Map(totales.map(t => [t.miembroLigaId, Number(t.puntos ?? 0)]))))
    }

    const numJornada = parseInt(num ?? '1', 10)
    if (isNaN(numJornada)) { res.status(400).json({ error: 'num debe ser un número' }); return }

    // Jornadas de la división de esta liga
    const jornadasDivision = await db.select().from(jornada)
      .where(eq(jornada.division, ligaRow.division))
      .orderBy(asc(jornada.numJornada))

    if (modo === 'jornada') {
      const jornadaRow = jornadasDivision.find(j => j.numJornada === numJornada)
      if (!jornadaRow || miembroIds.length === 0) return res.json(buildResult(new Map()))
      const rows = await db.select()
        .from(puntuacionJornada)
        .where(and(eq(puntuacionJornada.jornadaId, jornadaRow.id), inArray(puntuacionJornada.miembroLigaId, miembroIds)))
      return res.json(buildResult(new Map(rows.map(r => [r.miembroLigaId, r.puntos]))))
    }

    if (modo === 'acumulado') {
      const jornadaIds = jornadasDivision.filter(j => j.numJornada <= numJornada).map(j => j.id)
      if (jornadaIds.length === 0 || miembroIds.length === 0) return res.json(buildResult(new Map()))
      const acum = await db
        .select({ miembroLigaId: puntuacionJornada.miembroLigaId, puntos: sum(puntuacionJornada.puntos) })
        .from(puntuacionJornada)
        .where(and(inArray(puntuacionJornada.miembroLigaId, miembroIds), inArray(puntuacionJornada.jornadaId, jornadaIds)))
        .groupBy(puntuacionJornada.miembroLigaId)
      return res.json(buildResult(new Map(acum.map(a => [a.miembroLigaId, Number(a.puntos ?? 0)]))))
    }

    res.status(400).json({ error: 'modo no reconocido (total|jornada|acumulado)' })
  } catch (e) {
    console.error('[getClasificacion]', e)
    res.status(500).json({ error: 'Error al obtener clasificación' })
  }
}
