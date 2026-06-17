import { randomUUID } from 'crypto'
import { Response } from 'express'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  plantillaFantasy, clausulazoPendiente, miembroLiga, titularLiga,
  jugador, jugadorEquipo, equipo, transferencia, ofertaMercado, usuario,
} from '../db/schema'
import { AuthRequest } from '../middleware/auth.middleware'
import { registrarMovimientoSaldo, registrarCambioClausula } from '../lib/historial'

async function getMiembro(ligaId: string, usuarioId: string) {
  return db.query.miembroLiga.findFirst({
    where: and(eq(miembroLiga.ligaId, ligaId), eq(miembroLiga.usuarioId, usuarioId)),
  })
}

// ─── PLANTILLAS DE TODOS LOS EQUIPOS ──────────────

export const getPlantillasLiga = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const usuarioId = req.usuarioId!

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const plantillaRaw = await db
      .select({
        pfId: plantillaFantasy.id,
        pfMiembroLigaId: plantillaFantasy.miembroLigaId,
        pfJugadorId: plantillaFantasy.jugadorId,
        pfClausula: plantillaFantasy.clausula,
        pfJornadasBloqueo: plantillaFantasy.jornadasBloqueo,
        jId: jugador.id, jNombreCompleto: jugador.nombreCompleto, jNombre: jugador.nombre,
        jPosicion: jugador.posicion, jValor: jugador.valor, jDorsal: jugador.dorsal,
      })
      .from(plantillaFantasy)
      .innerJoin(jugador, eq(jugador.id, plantillaFantasy.jugadorId))
      .where(eq(plantillaFantasy.ligaId, ligaId))

    const jugadorIds   = plantillaRaw.map(p => p.pfJugadorId)
    const miembroIds   = [...new Set(plantillaRaw.map(p => p.pfMiembroLigaId))]

    const [pendientes, propietarios, equiposActivos] = await Promise.all([
      jugadorIds.length > 0
        ? db.select().from(clausulazoPendiente)
            .where(and(eq(clausulazoPendiente.ligaId, ligaId), inArray(clausulazoPendiente.jugadorId, jugadorIds)))
        : Promise.resolve([]),
      miembroIds.length > 0
        ? db.select({ mlId: miembroLiga.id, uUsername: usuario.username })
            .from(miembroLiga).innerJoin(usuario, eq(usuario.id, miembroLiga.usuarioId))
            .where(inArray(miembroLiga.id, miembroIds))
        : Promise.resolve([]),
      jugadorIds.length > 0
        ? db.select({
              jeJugadorId: jugadorEquipo.jugadorId,
              eNombre: equipo.nombre,
            })
            .from(jugadorEquipo)
            .innerJoin(equipo, eq(equipo.id, jugadorEquipo.equipoId))
            .where(and(eq(jugadorEquipo.activo, true), inArray(jugadorEquipo.jugadorId, jugadorIds)))
        : Promise.resolve([]),
    ])

    const pendienteMap   = new Map(pendientes.map(cp => [cp.jugadorId, cp]))
    const propietarioMap = new Map(propietarios.map(p => [p.mlId, p.uUsername]))
    const equipoMap      = new Map(equiposActivos.map(e => [e.jeJugadorId, e.eNombre]))

    res.json(plantillaRaw.map(p => ({
      plantillaId:     p.pfId,
      miembroLigaId:   p.pfMiembroLigaId,
      propietario:     propietarioMap.get(p.pfMiembroLigaId) ?? null,
      esMio:           p.pfMiembroLigaId === miembro.id,
      clausula:        p.pfClausula,
      jornadasBloqueo: p.pfJornadasBloqueo,
      pendiente:       pendienteMap.has(p.pfJugadorId) ? {
        compradorMiembroId: pendienteMap.get(p.pfJugadorId)!.compradorMiembroId,
        importe:            pendienteMap.get(p.pfJugadorId)!.importe,
      } : null,
      jugador: {
        id: p.jId, nombreCompleto: p.jNombreCompleto, nombre: p.jNombre,
        posicion: p.jPosicion, valor: p.jValor, dorsal: p.jDorsal,
        equipo: equipoMap.get(p.pfJugadorId) ?? null,
      },
    })))
  } catch (e) {
    console.error('[getPlantillasLiga]', e)
    res.status(500).json({ error: 'Error al obtener las plantillas' })
  }
}

// ─── EJECUTAR CLAUSULAZO ───────────────────────────

export const ejecutarClausulazo = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const jugadorId = req.params.jugadorId as string
  const usuarioId = req.usuarioId!

  try {
    const comprador = await getMiembro(ligaId, usuarioId)
    if (!comprador) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const [plantilla] = await db.select().from(plantillaFantasy)
      .where(and(eq(plantillaFantasy.ligaId, ligaId), eq(plantillaFantasy.jugadorId, jugadorId))).limit(1)
    if (!plantilla) { res.status(404).json({ error: 'Este jugador no pertenece a ningún equipo de la liga' }); return }
    if (plantilla.miembroLigaId === comprador.id) { res.status(400).json({ error: 'No puedes clausulazarte a ti mismo' }); return }
    if (plantilla.jornadasBloqueo > 0) { res.status(400).json({ error: `El jugador está bloqueado ${plantilla.jornadasBloqueo} jornada(s) más` }); return }

    const [pendiente] = await db.select().from(clausulazoPendiente)
      .where(and(eq(clausulazoPendiente.ligaId, ligaId), eq(clausulazoPendiente.jugadorId, jugadorId))).limit(1)
    if (pendiente) { res.status(409).json({ error: 'Ya han pagado la cláusula por este jugador' }); return }

    if (comprador.presupuestoRestante < plantilla.clausula) {
      res.status(400).json({ error: `Presupuesto insuficiente. La cláusula es ${plantilla.clausula}` }); return
    }

    const [esTitular] = await db.select({ id: titularLiga.jugadorId }).from(titularLiga)
      .where(and(eq(titularLiga.miembroLigaId, plantilla.miembroLigaId), eq(titularLiga.jugadorId, jugadorId))).limit(1)

    const [vendedorMiembro] = await db.select({ presupuestoRestante: miembroLiga.presupuestoRestante })
      .from(miembroLiga).where(eq(miembroLiga.id, plantilla.miembroLigaId)).limit(1)
    const [jugadorRow] = await db.select({ nombre: jugador.nombre })
      .from(jugador).where(eq(jugador.id, jugadorId)).limit(1)
    const nombreJugador = jugadorRow?.nombre ?? 'Jugador'

    if (esTitular) {
      // Transferencia diferida: el jugador está en el 11
      await db.transaction(async tx => {
        await tx.update(miembroLiga)
          .set({ presupuestoRestante: comprador.presupuestoRestante - plantilla.clausula })
          .where(eq(miembroLiga.id, comprador.id))
        await tx.update(miembroLiga)
          .set({ presupuestoRestante: vendedorMiembro.presupuestoRestante + plantilla.clausula })
          .where(eq(miembroLiga.id, plantilla.miembroLigaId))
        await tx.insert(clausulazoPendiente).values({
          id: randomUUID(), ligaId, jugadorId,
          compradorMiembroId: comprador.id,
          vendedorMiembroId: plantilla.miembroLigaId,
          importe: plantilla.clausula,
          creadoEn: new Date(),
        })
        await registrarMovimientoSaldo(tx, {
          miembroLigaId: comprador.id, ligaId, concepto: 'CLAUSULAZO_PAGO',
          importe: -plantilla.clausula, saldoResultante: comprador.presupuestoRestante - plantilla.clausula,
          descripcion: `Cláusula pagada por ${nombreJugador} (pendiente)`, jugadorId,
        })
        await registrarMovimientoSaldo(tx, {
          miembroLigaId: plantilla.miembroLigaId, ligaId, concepto: 'CLAUSULAZO_COBRO',
          importe: plantilla.clausula, saldoResultante: vendedorMiembro.presupuestoRestante + plantilla.clausula,
          descripcion: `Cláusula cobrada por ${nombreJugador}`, jugadorId,
        })
      })
      res.json({
        estado: 'PENDIENTE',
        mensaje: 'Cláusula pagada. El jugador pasará a tu equipo en la próxima jornada.',
        importe: plantilla.clausula,
      })
    } else {
      // Transferencia inmediata: el jugador no está en el 11
      const nuevaClausula = plantilla.clausula * 2
      await db.transaction(async tx => {
        // Cancelar oferta activa si existe
        await tx.update(ofertaMercado).set({ estado: 'CANCELADA' })
          .where(and(eq(ofertaMercado.ligaId, ligaId), eq(ofertaMercado.jugadorId, jugadorId), eq(ofertaMercado.estado, 'ACTIVA')))
        // Quitar del equipo anterior
        await tx.delete(plantillaFantasy)
          .where(and(eq(plantillaFantasy.ligaId, ligaId), eq(plantillaFantasy.jugadorId, jugadorId)))
        // Añadir al nuevo equipo
        await tx.insert(plantillaFantasy).values({
          id: randomUUID(), ligaId, miembroLigaId: comprador.id,
          jugadorId, precioCompra: plantilla.clausula,
          clausula: nuevaClausula, jornadasBloqueo: 3,
          creadoEn: new Date(),
        })
        // Transferir dinero
        await tx.update(miembroLiga)
          .set({ presupuestoRestante: comprador.presupuestoRestante - plantilla.clausula })
          .where(eq(miembroLiga.id, comprador.id))
        await tx.update(miembroLiga)
          .set({ presupuestoRestante: vendedorMiembro.presupuestoRestante + plantilla.clausula })
          .where(eq(miembroLiga.id, plantilla.miembroLigaId))
        // Registrar transferencia
        await tx.insert(transferencia).values({
          id: randomUUID(), jugadorId, ligaId,
          vendedorId: plantilla.miembroLigaId, compradorId: comprador.id,
          ofertaId: null, precio: plantilla.clausula, fecha: new Date(),
        })
        await registrarMovimientoSaldo(tx, {
          miembroLigaId: comprador.id, ligaId, concepto: 'CLAUSULAZO_PAGO',
          importe: -plantilla.clausula, saldoResultante: comprador.presupuestoRestante - plantilla.clausula,
          descripcion: `Clausulazo de ${nombreJugador}`, jugadorId,
        })
        await registrarMovimientoSaldo(tx, {
          miembroLigaId: plantilla.miembroLigaId, ligaId, concepto: 'CLAUSULAZO_COBRO',
          importe: plantilla.clausula, saldoResultante: vendedorMiembro.presupuestoRestante + plantilla.clausula,
          descripcion: `Clausulazo cobrado por ${nombreJugador}`, jugadorId,
        })
        await registrarCambioClausula(tx, {
          jugadorId, ligaId, miembroLigaId: comprador.id,
          clausulaAnterior: plantilla.clausula, clausulaNueva: nuevaClausula, motivo: 'CLAUSULAZO_NUEVO_DUENO',
        })
      })
      res.json({
        estado: 'COMPLETADO',
        mensaje: 'Clausulazo ejecutado. El jugador ya está en tu equipo.',
        importe: plantilla.clausula,
      })
    }
  } catch (e) {
    console.error('[ejecutarClausulazo]', e)
    res.status(500).json({ error: 'Error al ejecutar el clausulazo' })
  }
}

// ─── INVERTIR EN CLÁUSULA ──────────────────────────

export const invertirEnClausula = async (req: AuthRequest, res: Response) => {
  const ligaId    = req.params.ligaId as string
  const jugadorId = req.params.jugadorId as string
  const usuarioId = req.usuarioId!
  const { importe } = req.body

  if (!importe || importe <= 0) { res.status(400).json({ error: 'importe debe ser mayor que 0' }); return }

  try {
    const miembro = await getMiembro(ligaId, usuarioId)
    if (!miembro) { res.status(403).json({ error: 'No eres miembro de esta liga' }); return }

    const [plantilla] = await db.select().from(plantillaFantasy)
      .where(and(eq(plantillaFantasy.ligaId, ligaId), eq(plantillaFantasy.jugadorId, jugadorId))).limit(1)
    if (!plantilla || plantilla.miembroLigaId !== miembro.id) {
      res.status(403).json({ error: 'No tienes este jugador en tu equipo' }); return
    }
    if (miembro.presupuestoRestante < importe) {
      res.status(400).json({ error: 'Presupuesto insuficiente' }); return
    }

    const incremento    = importe * 2
    const nuevaClausula = plantilla.clausula + incremento
    const saldoNuevo    = miembro.presupuestoRestante - importe

    await db.transaction(async tx => {
      await tx.update(plantillaFantasy)
        .set({ clausula: nuevaClausula })
        .where(eq(plantillaFantasy.id, plantilla.id))
      await tx.update(miembroLiga)
        .set({ presupuestoRestante: saldoNuevo })
        .where(eq(miembroLiga.id, miembro.id))
      const [jugadorRow] = await tx.select({ nombre: jugador.nombre })
        .from(jugador).where(eq(jugador.id, jugadorId)).limit(1)
      const nombreJ = jugadorRow?.nombre ?? 'Jugador'
      await registrarMovimientoSaldo(tx, {
        miembroLigaId: miembro.id, ligaId, concepto: 'INVERSION_CLAUSULA',
        importe: -importe, saldoResultante: saldoNuevo,
        descripcion: `Inversión en cláusula de ${nombreJ}`, jugadorId,
      })
      await registrarCambioClausula(tx, {
        jugadorId, ligaId, miembroLigaId: miembro.id,
        clausulaAnterior: plantilla.clausula, clausulaNueva: nuevaClausula, motivo: 'INVERSION',
      })
    })

    res.json({ nuevaClausula, presupuestoRestante: saldoNuevo,
      mensaje: `Cláusula de ${nuevaClausula.toLocaleString('es-ES')} actualizada` })
  } catch (e) {
    console.error('[invertirEnClausula]', e)
    res.status(500).json({ error: 'Error al invertir en la cláusula' })
  }
}
