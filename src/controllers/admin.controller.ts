import { randomUUID } from 'crypto'
import { Response } from 'express'
import { AuthRequest } from '../middleware/auth.middleware'
import { eq, and, or, asc, desc, gte, isNull, lte, inArray, count, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  usuario, liga, jugador, jugadorEquipo, equipo, estadisticaJornada,
  configPuntuacion, historialAdmin, ofertaMercado, puja, miembroLiga,
  snapshotAlineacion, puntuacionJornada,
  Posicion, AccionPuntuacion, ResultadoPartido,
} from '../db/schema'
import { registrarAccion as registrar } from '../lib/registrarAccion'

// ─── JUGADORES ─────────────────────────────────────

export const getJugadoresAdmin = async (_req: AuthRequest, res: Response) => {
  try {
    const jugadores = await db.query.jugador.findMany({
      orderBy: asc(jugador.nombreCompleto),
      with: {
        historialEquipos: { where: eq(jugadorEquipo.activo, true), limit: 1, with: { equipo: true } },
      },
    })
    res.json(jugadores)
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
    const fichaje = await db.query.jugadorEquipo.findFirst({ where: eq(jugadorEquipo.id, id), with: { jugador: true, equipo: true } })
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
    const stats = await db.query.estadisticaJornada.findMany({
      where: eq(estadisticaJornada.jornadaId, jornadaId),
      with:  { jugadorEquipo: { with: { jugador: true, equipo: true } } },
    })
    stats.sort((a, b) => a.jugadorEquipo.jugador.nombreCompleto.localeCompare(b.jugadorEquipo.jugador.nombreCompleto))
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
  if (stats.convocado)          { const p = get('CONVOCADO');        d.convocado = p; total += p }
  if (stats.titular)            { const p = get('TITULAR');          d.titular   = p; total += p }
  if (stats.minutosJugados > 60){ const p = get('MINUTOS_60');       d.minutos60 = p; total += p }
  if (stats.goles > 0)          { const u = get('GOL'); const t = u * stats.goles; d.goles = { cantidad: stats.goles, puntosUnitarios: u, total: t }; total += t }
  if (stats.tarjetasAmarillas > 0) { const u = get('TARJETA_AMARILLA'); const t = u * stats.tarjetasAmarillas; d.tarjetasAmarillas = { cantidad: stats.tarjetasAmarillas, puntosUnitarios: u, total: t }; total += t }
  if (stats.tarjetaRoja)        { const p = get('TARJETA_ROJA');     d.tarjetaRoja = p; total += p }
  const accionRes: AccionPuntuacion = stats.resultado === 'VICTORIA' ? 'VICTORIA' : stats.resultado === 'EMPATE' ? 'EMPATE' : 'DERROTA'
  const pRes = get(accionRes); d.resultado = { tipo: stats.resultado, puntos: pRes }; total += pRes
  return { total, desglose: d }
}

export const editarEstadistica = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string
  const { convocado, titular, minutosJugados, goles, tarjetasAmarillas, tarjetaRoja, resultado } = req.body

  try {
    const antes = await db.query.estadisticaJornada.findFirst({
      where: eq(estadisticaJornada.id, id),
      with:  { jugadorEquipo: { with: { jugador: true } }, jornada: true },
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
    res.json(nueva)
  } catch {
    res.status(500).json({ error: 'Error al actualizar configuración' })
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

// ─── HISTORIAL ─────────────────────────────────────

export const getHistorial = async (_req: AuthRequest, res: Response) => {
  try {
    const historial = await db.query.historialAdmin.findMany({
      orderBy: desc(historialAdmin.creadoEn),
      limit:   500,
      with:    { admin: { columns: { username: true } } },
    })
    res.json(historial)
  } catch {
    res.status(500).json({ error: 'Error al obtener historial' })
  }
}
