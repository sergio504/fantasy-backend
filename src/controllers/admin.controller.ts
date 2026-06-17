import { randomUUID } from 'crypto'
import { Response } from 'express'
import { AuthRequest } from '../middleware/auth.middleware'
import { eq, and, or, asc, desc, gte, isNull, lte, inArray, count, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  usuario, liga, jugador, jugadorEquipo, equipo, estadisticaJornada,
  configPuntuacion, configEconomia, configRevalorizacion, historialAdmin, historialConfig, ofertaMercado, puja, miembroLiga,
  snapshotAlineacion, puntuacionJornada, jornada, aliasEquipo, aliasJugador,
  Posicion, AccionPuntuacion, ResultadoPartido,
} from '../db/schema'
import { registrarAccion as registrar } from '../lib/registrarAccion'
import { registrarCambioConfig } from '../lib/historial'

// ─── JUGADORES ─────────────────────────────────────

export const getJugadoresAdmin = async (_req: AuthRequest, res: Response) => {
  try {
    const jugadores = await db.select().from(jugador).orderBy(asc(jugador.nombreCompleto))
    const jeRows = jugadores.length > 0
      ? await db.select({
            jeJugadorId: jugadorEquipo.jugadorId, jeId: jugadorEquipo.id,
            jeEquipoId: jugadorEquipo.equipoId, jeDesde: jugadorEquipo.desde,
            jeHasta: jugadorEquipo.hasta, jeActivo: jugadorEquipo.activo, jeCreadoEn: jugadorEquipo.creadoEn,
            eId: equipo.id, eNombre: equipo.nombre, eDivision: equipo.division, eCreadoEn: equipo.creadoEn,
          })
          .from(jugadorEquipo)
          .innerJoin(equipo, eq(equipo.id, jugadorEquipo.equipoId))
          .where(and(eq(jugadorEquipo.activo, true), inArray(jugadorEquipo.jugadorId, jugadores.map(j => j.id))))
      : []
    const histMap = new Map(jeRows.map(r => [r.jeJugadorId, {
      id: r.jeId, jugadorId: r.jeJugadorId, equipoId: r.jeEquipoId,
      desde: r.jeDesde, hasta: r.jeHasta, activo: r.jeActivo, creadoEn: r.jeCreadoEn,
      equipo: { id: r.eId, nombre: r.eNombre, division: r.eDivision, creadoEn: r.eCreadoEn },
    }]))
    res.json(jugadores.map(j => ({ ...j, historialEquipos: histMap.has(j.id) ? [histMap.get(j.id)!] : [] })))
  } catch {
    res.status(500).json({ error: 'Error al obtener jugadores' })
  }
}

export const crearJugador = async (req: AuthRequest, res: Response) => {
  const { nombreCompleto, nombre, dorsal, edad, posicion } = req.body
  const posiciones: Posicion[] = ['PORTERO', 'DEFENSA', 'CENTROCAMPISTA', 'DELANTERO', 'UNKNOWN']
  if (!nombreCompleto || !nombre || !posicion) { res.status(400).json({ error: 'nombreCompleto, nombre y posicion son obligatorios' }); return }
  if (!posiciones.includes(posicion)) { res.status(400).json({ error: `posicion debe ser uno de: ${posiciones.join(', ')}` }); return }

  try {
    const id = randomUUID()
    await db.insert(jugador).values({ id, nombreCompleto, nombre, dorsal, edad, posicion, creadoEn: new Date() })
    const [j] = await db.select().from(jugador).where(eq(jugador.id, id)).limit(1)
    await registrar(req.usuarioId!, 'CREAR_JUGADOR', 'Jugador', id, j)
    res.status(201).json(j)
  } catch {
    res.status(500).json({ error: 'Error al crear jugador' })
  }
}

export const editarJugador = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const { nombreCompleto, nombre, dorsal, edad, posicion, valor } = req.body

  try {
    const [antes] = await db.select().from(jugador).where(eq(jugador.id, id)).limit(1)
    if (!antes) { res.status(404).json({ error: 'Jugador no encontrado' }); return }

    await db.update(jugador).set({
      ...(nombreCompleto !== undefined && { nombreCompleto }),
      ...(nombre       !== undefined && { nombre }),
      ...(dorsal       !== undefined && { dorsal }),
      ...(edad         !== undefined && { edad }),
      ...(posicion     !== undefined && { posicion }),
      ...(valor        !== undefined && { valor }),
    }).where(eq(jugador.id, id))

    const [despues] = await db.select().from(jugador).where(eq(jugador.id, id)).limit(1)
    await registrar(req.usuarioId!, 'EDITAR_JUGADOR', 'Jugador', id, despues, antes)
    res.json(despues)
  } catch {
    res.status(500).json({ error: 'Error al editar jugador' })
  }
}

// ─── FICHAJES ──────────────────────────────────────

export const crearFichaje = async (req: AuthRequest, res: Response) => {
  const { jugadorId, equipoId, desde } = req.body
  if (!jugadorId || !equipoId) { res.status(400).json({ error: 'jugadorId y equipoId son obligatorios' }); return }

  try {
    await db.update(jugadorEquipo).set({ activo: false, hasta: desde ? new Date(desde) : new Date() })
      .where(and(eq(jugadorEquipo.jugadorId, jugadorId), eq(jugadorEquipo.activo, true)))
    const id = randomUUID()
    await db.insert(jugadorEquipo).values({ id, jugadorId, equipoId, desde: desde ? new Date(desde) : new Date(), activo: true, creadoEn: new Date() })
    const fRows = await db.select({
      jeId: jugadorEquipo.id, jeJugadorId: jugadorEquipo.jugadorId, jeEquipoId: jugadorEquipo.equipoId,
      jeDesde: jugadorEquipo.desde, jeHasta: jugadorEquipo.hasta, jeActivo: jugadorEquipo.activo, jeCreadoEn: jugadorEquipo.creadoEn,
      jId: jugador.id, jNombreCompleto: jugador.nombreCompleto, jNombre: jugador.nombre,
      jDorsal: jugador.dorsal, jEdad: jugador.edad, jPosicion: jugador.posicion,
      jValor: jugador.valor, jCreadoEn: jugador.creadoEn,
      eId: equipo.id, eNombre: equipo.nombre, eDivision: equipo.division, eCreadoEn: equipo.creadoEn,
    }).from(jugadorEquipo)
      .innerJoin(jugador, eq(jugador.id, jugadorEquipo.jugadorId))
      .innerJoin(equipo, eq(equipo.id, jugadorEquipo.equipoId))
      .where(eq(jugadorEquipo.id, id)).limit(1)
    const r = fRows[0]
    const fichaje = r ? {
      id: r.jeId, jugadorId: r.jeJugadorId, equipoId: r.jeEquipoId,
      desde: r.jeDesde, hasta: r.jeHasta, activo: r.jeActivo, creadoEn: r.jeCreadoEn,
      jugador: { id: r.jId, nombreCompleto: r.jNombreCompleto, nombre: r.jNombre, dorsal: r.jDorsal, edad: r.jEdad, posicion: r.jPosicion, valor: r.jValor, creadoEn: r.jCreadoEn },
      equipo:  { id: r.eId, nombre: r.eNombre, division: r.eDivision, creadoEn: r.eCreadoEn },
    } : null
    await registrar(req.usuarioId!, 'CREAR_FICHAJE', 'JugadorEquipo', id, fichaje!)
    res.status(201).json(fichaje)
  } catch {
    res.status(500).json({ error: 'Error al crear fichaje' })
  }
}

export const cerrarFichaje = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const { hasta } = req.body

  try {
    const [antes] = await db.select().from(jugadorEquipo).where(eq(jugadorEquipo.id, id)).limit(1)
    if (!antes) { res.status(404).json({ error: 'Fichaje no encontrado' }); return }
    await db.update(jugadorEquipo).set({ activo: false, hasta: hasta ? new Date(hasta) : new Date() }).where(eq(jugadorEquipo.id, id))
    const [despues] = await db.select().from(jugadorEquipo).where(eq(jugadorEquipo.id, id)).limit(1)
    await registrar(req.usuarioId!, 'CERRAR_FICHAJE', 'JugadorEquipo', id, despues, antes)
    res.json(despues)
  } catch {
    res.status(500).json({ error: 'Error al cerrar fichaje' })
  }
}

// ─── EQUIPOS ───────────────────────────────────────

export const getEquipos = async (_req: AuthRequest, res: Response) => {
  try {
    const equipos = await db.select().from(equipo).orderBy(asc(equipo.division), asc(equipo.nombre))
    res.json(equipos)
  } catch {
    res.status(500).json({ error: 'Error al obtener equipos' })
  }
}

// ─── ESTADÍSTICAS ──────────────────────────────────

export const getEstadisticasJornada = async (req: AuthRequest, res: Response) => {
  const jornadaId = req.params.jornadaId as string
  try {
    const statsRaw = await db.select().from(estadisticaJornada).where(eq(estadisticaJornada.jornadaId, jornadaId))
    const jeIds = statsRaw.map(s => s.jugadorEquipoId)
    const jeRows = jeIds.length > 0
      ? await db.select({
            jeId: jugadorEquipo.id, jeJugadorId: jugadorEquipo.jugadorId, jeEquipoId: jugadorEquipo.equipoId,
            jeDesde: jugadorEquipo.desde, jeHasta: jugadorEquipo.hasta, jeActivo: jugadorEquipo.activo, jeCreadoEn: jugadorEquipo.creadoEn,
            jId: jugador.id, jNombreCompleto: jugador.nombreCompleto, jNombre: jugador.nombre,
            jDorsal: jugador.dorsal, jEdad: jugador.edad, jPosicion: jugador.posicion, jValor: jugador.valor, jCreadoEn: jugador.creadoEn,
            eId: equipo.id, eNombre: equipo.nombre, eDivision: equipo.division, eCreadoEn: equipo.creadoEn,
          }).from(jugadorEquipo)
          .innerJoin(jugador, eq(jugador.id, jugadorEquipo.jugadorId))
          .innerJoin(equipo, eq(equipo.id, jugadorEquipo.equipoId))
          .where(inArray(jugadorEquipo.id, jeIds))
      : []
    const jeMap = new Map(jeRows.map(r => [r.jeId, r]))
    const stats = statsRaw
      .map(s => {
        const je = jeMap.get(s.jugadorEquipoId)!
        return { ...s, jugadorEquipo: { id: je.jeId, jugadorId: je.jeJugadorId, equipoId: je.jeEquipoId, desde: je.jeDesde, hasta: je.jeHasta, activo: je.jeActivo, creadoEn: je.jeCreadoEn,
          jugador: { id: je.jId, nombreCompleto: je.jNombreCompleto, nombre: je.jNombre, dorsal: je.jDorsal, edad: je.jEdad, posicion: je.jPosicion, valor: je.jValor, creadoEn: je.jCreadoEn },
          equipo:  { id: je.eId, nombre: je.eNombre, division: je.eDivision, creadoEn: je.eCreadoEn },
        }}
      })
      .sort((a, b) => a.jugadorEquipo.jugador.nombreCompleto.localeCompare(b.jugadorEquipo.jugador.nombreCompleto))
    res.json(stats)
  } catch {
    res.status(500).json({ error: 'Error al obtener estadísticas' })
  }
}

function recalcularPuntos(
  stats: {
    convocado: boolean; titular: boolean; minutosJugados: number
    goles: number; golesDePenalti: number; golEnPropia: number
    golesAFavor: number; golesEncajados: number
    diferenciaGoles: number
    tarjetasAmarillas: number; tarjetaRoja: boolean
    resultado: ResultadoPartido
  },
  posicion: Posicion,
  config: { posicion: Posicion | null; accion: AccionPuntuacion; puntos: number }[]
) {
  function get(accion: AccionPuntuacion): number {
    return config.find(c => c.accion === accion && c.posicion === posicion)?.puntos
      ?? config.find(c => c.accion === accion && c.posicion === null)?.puntos ?? 0
  }
  const d: Record<string, unknown> = {}
  let total = 0
  const golesNormales = stats.goles - stats.golesDePenalti

  if (stats.convocado)                  { const p = get('CONVOCADO');       d.convocado     = p; total += p }
  if (stats.minutosJugados > 0)         { const p = get('JUEGA');           d.juega         = p; total += p }
  if (stats.titular)                    { const p = get('TITULAR');         d.titular       = p; total += p }
  if (stats.minutosJugados > 60)        { const p = get('MINUTOS_60');      d.minutos60     = p; total += p }
  if (golesNormales > 0)                { const u = get('GOL');             const t = u * golesNormales;        d.goles          = { cantidad: golesNormales,        puntosUnitarios: u, total: t }; total += t }
  if (stats.golesDePenalti > 0)         { const u = get('GOL_PENALTY');     const t = u * stats.golesDePenalti; d.golesPenalty   = { cantidad: stats.golesDePenalti, puntosUnitarios: u, total: t }; total += t }
  if (stats.golEnPropia > 0)            { const u = get('GOL_PROPIA');      const t = u * stats.golEnPropia;    d.golEnPropia    = { cantidad: stats.golEnPropia,    puntosUnitarios: u, total: t }; total += t }
  if (stats.golesAFavor > 0)            { const u = get('GOL_A_FAVOR');     const t = u * stats.golesAFavor;    d.golesAFavor    = { cantidad: stats.golesAFavor,    puntosUnitarios: u, total: t }; total += t }
  if (stats.golesEncajados > 0)         { const u = get('GOL_ENCAJADO');    const t = u * stats.golesEncajados; d.golesEncajados = { cantidad: stats.golesEncajados, puntosUnitarios: u, total: t }; total += t }
  const accionRes: AccionPuntuacion = stats.resultado === 'VICTORIA' ? 'VICTORIA' : stats.resultado === 'EMPATE' ? 'EMPATE' : 'DERROTA'
  const pRes = get(accionRes); d.resultado = { tipo: stats.resultado, puntos: pRes }; total += pRes
  if (stats.diferenciaGoles > 3)        { const p = get('GOLEADA_FAVOR');   d.goleadaFavor   = p; total += p }
  if (stats.diferenciaGoles < -3)       { const p = get('GOLEADA_CONTRA');  d.goleadaContra  = p; total += p }
  if (stats.tarjetasAmarillas >= 2)     { const p = get('DOBLE_AMARILLA');  d.dobleAmarilla  = p; total += p }
  else if (stats.tarjetasAmarillas > 0) { const p = get('TARJETA_AMARILLA');d.tarjetaAmarilla= p; total += p }
  if (stats.tarjetaRoja)                { const p = get('TARJETA_ROJA');    d.tarjetaRoja    = p; total += p }
  return { total, desglose: d }
}

export const editarEstadistica = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const { convocado, titular, minutosJugados, goles, tarjetasAmarillas, tarjetaRoja, resultado } = req.body

  try {
    const [antesRaw] = await db.select().from(estadisticaJornada).where(eq(estadisticaJornada.id, id)).limit(1)
    if (!antesRaw) { res.status(404).json({ error: 'Estadística no encontrada' }); return }
    const [[jeRow], [jornadaRow]] = await Promise.all([
      db.select({ jPosicion: jugador.posicion }).from(jugadorEquipo)
        .innerJoin(jugador, eq(jugador.id, jugadorEquipo.jugadorId))
        .where(eq(jugadorEquipo.id, antesRaw.jugadorEquipoId)).limit(1),
      db.select().from(jornada).where(eq(jornada.id, antesRaw.jornadaId)).limit(1),
    ])
    const antes = { ...antesRaw, jugadorEquipo: { jugador: { posicion: jeRow.jPosicion } }, jornada: jornadaRow }

    const nuevosDatos = {
      convocado:         convocado         ?? antes.convocado,
      titular:           titular           ?? antes.titular,
      minutosJugados:    minutosJugados    ?? antes.minutosJugados,
      goles:             goles             ?? antes.goles,
      golesDePenalti:    antes.golesDePenalti,
      golEnPropia:       antes.golEnPropia,
      golesAFavor:       antes.golesAFavor,
      golesEncajados:    antes.golesEncajados,
      diferenciaGoles:   antes.diferenciaGoles,
      tarjetasAmarillas: tarjetasAmarillas ?? antes.tarjetasAmarillas,
      tarjetaRoja:       tarjetaRoja       ?? antes.tarjetaRoja,
      resultado:         resultado         ?? antes.resultado,
    }

    const config = await db.select().from(configPuntuacion).where(
      and(eq(configPuntuacion.activo, true), lte(configPuntuacion.desde, antes.jornada.fechaCierre),
          or(isNull(configPuntuacion.hasta), gte(configPuntuacion.hasta, antes.jornada.fechaCierre)))
    )

    const { total, desglose } = recalcularPuntos(nuevosDatos, antes.jugadorEquipo.jugador.posicion, config)
    const puntosAntes = antes.puntosCalculados
    const diferencia  = total - puntosAntes

    await db.update(estadisticaJornada)
      .set({ ...nuevosDatos, puntosCalculados: total, desglose: desglose as any })
      .where(eq(estadisticaJornada.id, id))
    const [despues] = await db.select().from(estadisticaJornada).where(eq(estadisticaJornada.id, id)).limit(1)

    if (diferencia !== 0) {
      const snapshots = await db.select().from(snapshotAlineacion)
        .where(and(eq(snapshotAlineacion.jornadaId, antes.jornadaId), eq(snapshotAlineacion.jugadorEquipoId, antes.jugadorEquipoId)))
      for (const snap of snapshots) {
        const delta = snap.esCapitan ? diferencia * 2 : diferencia
        await db.update(puntuacionJornada)
          .set({ puntos: sql`${puntuacionJornada.puntos} + ${delta}` })
          .where(and(eq(puntuacionJornada.jornadaId, antes.jornadaId), eq(puntuacionJornada.miembroLigaId, snap.miembroLigaId)))
        await db.update(miembroLiga)
          .set({ puntuacion: sql`${miembroLiga.puntuacion} + ${delta}` })
          .where(eq(miembroLiga.id, snap.miembroLigaId))
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
    const config = await db.select().from(configPuntuacion).where(eq(configPuntuacion.activo, true))
      .orderBy(asc(configPuntuacion.posicion), asc(configPuntuacion.accion))
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
    const [actual] = await db.select().from(configPuntuacion).where(eq(configPuntuacion.id, id)).limit(1)
    if (!actual || !actual.activo) { res.status(404).json({ error: 'Configuración no encontrada' }); return }

    const ahora   = new Date()
    await db.update(configPuntuacion).set({ activo: false, hasta: ahora }).where(eq(configPuntuacion.id, id))
    const nuevaId = randomUUID()
    await db.insert(configPuntuacion).values({ id: nuevaId, posicion: actual.posicion, accion: actual.accion, puntos, desde: ahora, activo: true, descripcion: descripcion ?? actual.descripcion })
    const [nueva] = await db.select().from(configPuntuacion).where(eq(configPuntuacion.id, nuevaId)).limit(1)

    await registrar(req.usuarioId!, 'ACTUALIZAR_CONFIG', 'ConfigPuntuacion', nuevaId, nueva as object, actual as object)
    await registrarCambioConfig({
      tipo: 'PUNTUACION',
      campo: `${actual.accion}${actual.posicion ? ` · ${actual.posicion}` : ''}`,
      valorAnterior: actual.puntos,
      valorNuevo: puntos,
      adminId: req.usuarioId!,
    })
    res.json(nueva)
  } catch {
    res.status(500).json({ error: 'Error al actualizar configuración' })
  }
}

// ─── CONFIG ECONOMÍA ───────────────────────────────

const DEFAULTS_ECONOMIA: Record<string, { valor: number; descripcion: string }> = {
  INGRESO_FIJO:      { valor: 500_000,   descripcion: 'Ingreso fijo por jornada para todos los equipos' },
  INGRESO_POR_PUNTO: { valor:  50_000,   descripcion: 'Ingreso adicional por cada punto conseguido' },
  BONUS_P1:          { valor: 3_000_000, descripcion: 'Bonus por quedar 1º en la liga esta jornada' },
  BONUS_P2:          { valor: 2_000_000, descripcion: 'Bonus por quedar 2º en la liga esta jornada' },
  BONUS_P3:          { valor: 1_500_000, descripcion: 'Bonus por quedar 3º en la liga esta jornada' },
  BONUS_P4:          { valor: 1_000_000, descripcion: 'Bonus por quedar 4º en la liga esta jornada' },
  BONUS_P5:          { valor:   500_000, descripcion: 'Bonus por quedar 5º en la liga esta jornada' },
}

export const getConfigEconomia = async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await db.select().from(configEconomia)
    const mapa = new Map(rows.map(r => [r.clave, r]))
    const resultado = Object.entries(DEFAULTS_ECONOMIA).map(([clave, def]) => {
      const row = mapa.get(clave)
      return { clave, valor: row?.valor ?? def.valor, descripcion: row?.descripcion ?? def.descripcion, id: row?.id ?? null }
    })
    res.json(resultado)
  } catch {
    res.status(500).json({ error: 'Error al obtener config economía' })
  }
}

export const actualizarConfigEconomia = async (req: AuthRequest, res: Response) => {
  const clave = req.params.clave as string
  const { valor } = req.body
  if (valor === undefined || isNaN(Number(valor))) { res.status(400).json({ error: 'valor numérico obligatorio' }); return }
  if (!DEFAULTS_ECONOMIA[clave]) { res.status(404).json({ error: 'Clave no reconocida' }); return }

  try {
    const [existing] = await db.select().from(configEconomia).where(eq(configEconomia.clave, clave)).limit(1)
    const valorAnterior = existing?.valor ?? DEFAULTS_ECONOMIA[clave].valor
    if (existing) {
      await db.update(configEconomia).set({ valor: Number(valor) }).where(eq(configEconomia.clave, clave))
    } else {
      await db.insert(configEconomia).values({ id: randomUUID(), clave, valor: Number(valor), descripcion: DEFAULTS_ECONOMIA[clave].descripcion })
    }
    await registrarCambioConfig({
      tipo: 'ECONOMIA',
      campo: `${clave} · ${DEFAULTS_ECONOMIA[clave].descripcion}`,
      valorAnterior,
      valorNuevo: Number(valor),
      adminId: req.usuarioId!,
    })
    res.json({ clave, valor: Number(valor) })
  } catch {
    res.status(500).json({ error: 'Error al actualizar config economía' })
  }
}

// ─── CONFIG REVALORIZACIÓN ─────────────────────────

const DEFAULTS_REVALORIZACION = [
  { orden: 1, puntosHasta: 0,    porcentaje: -8, descripcion: '0 puntos' },
  { orden: 2, puntosHasta: 4,    porcentaje: -5, descripcion: '1-4 puntos' },
  { orden: 3, puntosHasta: 8,    porcentaje: -2, descripcion: '5-8 puntos' },
  { orden: 4, puntosHasta: 12,   porcentaje:  3, descripcion: '9-12 puntos' },
  { orden: 5, puntosHasta: 17,   porcentaje:  7, descripcion: '13-17 puntos' },
  { orden: 6, puntosHasta: null, porcentaje: 12, descripcion: '18+ puntos' },
]

export const getConfigRevalorizacion = async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await db.select().from(configRevalorizacion).orderBy(asc(configRevalorizacion.orden))
    if (rows.length === 0) {
      res.json(DEFAULTS_REVALORIZACION.map(d => ({ ...d, id: null })))
      return
    }
    res.json(rows)
  } catch {
    // Tabla no creada aún: devolver defaults para que el panel sea visible
    res.json(DEFAULTS_REVALORIZACION.map(d => ({ ...d, id: null })))
  }
}

export const actualizarConfigRevalorizacion = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const { porcentaje } = req.body
  if (porcentaje === undefined || isNaN(Number(porcentaje))) {
    res.status(400).json({ error: 'porcentaje numérico obligatorio' }); return
  }

  try {
    const [existing] = await db.select().from(configRevalorizacion).where(eq(configRevalorizacion.id, id)).limit(1)
    if (!existing) { res.status(404).json({ error: 'Tramo no encontrado' }); return }

    await db.update(configRevalorizacion).set({ porcentaje: Number(porcentaje) }).where(eq(configRevalorizacion.id, id))
    await registrarCambioConfig({
      tipo: 'REVALORIZACION',
      campo: existing.descripcion ?? `Tramo orden ${existing.orden}`,
      valorAnterior: existing.porcentaje,
      valorNuevo: Number(porcentaje),
      adminId: req.usuarioId!,
    })
    res.json({ id, porcentaje: Number(porcentaje) })
  } catch {
    res.status(500).json({ error: 'Error al actualizar config revalorización' })
  }
}

// ─── USUARIOS ──────────────────────────────────────

export const getUsuarios = async (_req: AuthRequest, res: Response) => {
  try {
    const usuarios = await db.select({ id: usuario.id, email: usuario.email, username: usuario.username, esAdmin: usuario.esAdmin, activo: usuario.activo, creadoEn: usuario.creadoEn })
      .from(usuario).orderBy(asc(usuario.creadoEn))

    const userIds = usuarios.map(u => u.id)
    if (userIds.length === 0) { res.json([]); return }

    const [membCount, ligasCount] = await Promise.all([
      db.select({ userId: miembroLiga.usuarioId, total: count() }).from(miembroLiga).where(inArray(miembroLiga.usuarioId, userIds)).groupBy(miembroLiga.usuarioId),
      db.select({ userId: liga.creadorId, total: count() }).from(liga).where(inArray(liga.creadorId, userIds)).groupBy(liga.creadorId),
    ])
    const membMap  = new Map(membCount.map(c => [c.userId, c.total]))
    const ligasMap = new Map(ligasCount.map(c => [c.userId, c.total]))

    res.json(usuarios.map(u => ({ ...u, _count: { membresias: membMap.get(u.id) ?? 0, ligasCreadas: ligasMap.get(u.id) ?? 0 } })))
  } catch {
    res.status(500).json({ error: 'Error al obtener usuarios' })
  }
}

export const toggleActivoUsuario = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  if (id === req.usuarioId) { res.status(400).json({ error: 'No puedes desactivarte a ti mismo' }); return }

  try {
    const [user] = await db.select().from(usuario).where(eq(usuario.id, id)).limit(1)
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return }
    await db.update(usuario).set({ activo: !user.activo }).where(eq(usuario.id, id))
    const actualizado = { id: user.id, username: user.username, activo: !user.activo }
    await registrar(req.usuarioId!, 'EDITAR_JUGADOR', 'Usuario', id, { activo: actualizado.activo }, { activo: user.activo })
    res.json(actualizado)
  } catch {
    res.status(500).json({ error: 'Error al actualizar usuario' })
  }
}

// ─── MERCADO AUTOMÁTICO ────────────────────────────

export const lanzarMercadoManual = async (req: AuthRequest, res: Response) => {
  try {
    const { ponerJugadoresEnMercado } = await import('../jobs/mercadoAutomatico')
    const resumen       = await ponerJugadoresEnMercado()
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
    const ahora         = new Date()
    const haceUnaSemana = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000)

    const [
      [{ total: totalUsuarios }],
      [{ total: nuevosUltimaSemana }],
      [{ total: accesosUltimaSemana }],
      [{ total: ligasPublicas }],
      [{ total: ligasPrivadas }],
      [{ total: totalJugadores }],
      [{ total: ofertasActivas }],
      [{ total: ofertasVendidas }],
      [{ total: ofertasCanceladas }],
      [{ total: totalPujas }],
      usuariosRecientes,
    ] = await Promise.all([
      db.select({ total: count() }).from(usuario),
      db.select({ total: count() }).from(usuario).where(gte(usuario.creadoEn, haceUnaSemana)),
      db.select({ total: count() }).from(usuario).where(gte(usuario.ultimoAcceso, haceUnaSemana)),
      db.select({ total: count() }).from(liga).where(eq(liga.publica, true)),
      db.select({ total: count() }).from(liga).where(eq(liga.publica, false)),
      db.select({ total: count() }).from(jugador),
      db.select({ total: count() }).from(ofertaMercado).where(eq(ofertaMercado.estado, 'ACTIVA')),
      db.select({ total: count() }).from(ofertaMercado).where(eq(ofertaMercado.estado, 'VENDIDA')),
      db.select({ total: count() }).from(ofertaMercado).where(eq(ofertaMercado.estado, 'CANCELADA')),
      db.select({ total: count() }).from(puja),
      db.select({ creadoEn: usuario.creadoEn }).from(usuario).where(gte(usuario.creadoEn, haceUnaSemana)),
    ])

    const registrosPorDia: { dia: string; usuarios: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(ahora); d.setDate(d.getDate() - i)
      const diaStr = d.toISOString().split('T')[0]
      registrosPorDia.push({ dia: diaStr, usuarios: usuariosRecientes.filter(u => u.creadoEn.toISOString().split('T')[0] === diaStr).length })
    }

    res.json({
      usuarios: { total: totalUsuarios, nuevosUltimaSemana, accesosUltimaSemana },
      ligas:    { publicas: ligasPublicas, privadas: ligasPrivadas, total: ligasPublicas + ligasPrivadas },
      jugadores: { total: totalJugadores },
      mercado:  { ofertasActivas, ofertasVendidas, ofertasCanceladas, totalPujas },
      registrosPorDia,
    })
  } catch {
    res.status(500).json({ error: 'Error al obtener dashboard' })
  }
}

// ─── ALIASES ───────────────────────────────────────

export const getAliasesEquipos = async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await db
      .select({ alias: aliasEquipo, equipo: { id: equipo.id, nombre: equipo.nombre } })
      .from(aliasEquipo)
      .innerJoin(equipo, eq(aliasEquipo.equipoId, equipo.id))
      .orderBy(asc(equipo.nombre))
    res.json(rows)
  } catch {
    res.status(500).json({ error: 'Error al obtener aliases de equipos' })
  }
}

export const crearAliasEquipo = async (req: AuthRequest, res: Response) => {
  const { equipoId, alias } = req.body
  if (!equipoId || !alias) { res.status(400).json({ error: 'equipoId y alias son obligatorios' }); return }
  try {
    const [eq_] = await db.select().from(equipo).where(eq(equipo.id, equipoId)).limit(1)
    if (!eq_) { res.status(404).json({ error: 'Equipo no encontrado' }); return }
    const id = randomUUID()
    await db.insert(aliasEquipo).values({ id, equipoId, alias })
    const [nuevo] = await db.select().from(aliasEquipo).where(eq(aliasEquipo.id, id)).limit(1)
    res.status(201).json(nuevo)
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') { res.status(409).json({ error: 'Ese alias ya existe' }); return }
    res.status(500).json({ error: 'Error al crear alias' })
  }
}

export const eliminarAliasEquipo = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  try {
    const [existente] = await db.select().from(aliasEquipo).where(eq(aliasEquipo.id, id)).limit(1)
    if (!existente) { res.status(404).json({ error: 'Alias no encontrado' }); return }
    await db.delete(aliasEquipo).where(eq(aliasEquipo.id, id))
    res.json({ mensaje: 'Alias eliminado' })
  } catch {
    res.status(500).json({ error: 'Error al eliminar alias' })
  }
}

export const getAliasesJugadores = async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await db
      .select({ alias: aliasJugador, jugador: { id: jugador.id, nombreCompleto: jugador.nombreCompleto } })
      .from(aliasJugador)
      .innerJoin(jugador, eq(aliasJugador.jugadorId, jugador.id))
      .orderBy(asc(jugador.nombreCompleto))
    res.json(rows)
  } catch {
    res.status(500).json({ error: 'Error al obtener aliases de jugadores' })
  }
}

export const crearAliasJugador = async (req: AuthRequest, res: Response) => {
  const { jugadorId, alias } = req.body
  if (!jugadorId || !alias) { res.status(400).json({ error: 'jugadorId y alias son obligatorios' }); return }
  try {
    const [jug] = await db.select().from(jugador).where(eq(jugador.id, jugadorId)).limit(1)
    if (!jug) { res.status(404).json({ error: 'Jugador no encontrado' }); return }
    const id = randomUUID()
    await db.insert(aliasJugador).values({ id, jugadorId, alias })
    const [nuevo] = await db.select().from(aliasJugador).where(eq(aliasJugador.id, id)).limit(1)
    res.status(201).json(nuevo)
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') { res.status(409).json({ error: 'Ese alias ya existe' }); return }
    res.status(500).json({ error: 'Error al crear alias' })
  }
}

export const eliminarAliasJugador = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  try {
    const [existente] = await db.select().from(aliasJugador).where(eq(aliasJugador.id, id)).limit(1)
    if (!existente) { res.status(404).json({ error: 'Alias no encontrado' }); return }
    await db.delete(aliasJugador).where(eq(aliasJugador.id, id))
    res.json({ mensaje: 'Alias eliminado' })
  } catch {
    res.status(500).json({ error: 'Error al eliminar alias' })
  }
}

// ─── HISTORIAL CONFIG ──────────────────────────────

export const getHistorialConfig = async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await db.select({
      hc: historialConfig,
      adminUsername: usuario.username,
    })
      .from(historialConfig)
      .innerJoin(usuario, eq(usuario.id, historialConfig.adminId))
      .orderBy(desc(historialConfig.creadoEn))
      .limit(500)
    res.json(rows.map(r => ({ ...r.hc, adminUsername: r.adminUsername })))
  } catch {
    res.status(500).json({ error: 'Error al obtener historial de configuración' })
  }
}

// ─── HISTORIAL ─────────────────────────────────────

export const getHistorial = async (_req: AuthRequest, res: Response) => {
  try {
    const historialRaw = await db.select().from(historialAdmin).orderBy(desc(historialAdmin.creadoEn)).limit(500)
    const adminIds = [...new Set(historialRaw.map(h => h.adminId))]
    const admins = adminIds.length > 0
      ? await db.select({ id: usuario.id, username: usuario.username }).from(usuario).where(inArray(usuario.id, adminIds))
      : []
    const adminMap = new Map(admins.map(a => [a.id, a]))
    res.json(historialRaw.map(h => ({ ...h, admin: adminMap.has(h.adminId) ? { username: adminMap.get(h.adminId)!.username } : null })))
  } catch {
    res.status(500).json({ error: 'Error al obtener historial' })
  }
}
