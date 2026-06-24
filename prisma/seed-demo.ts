import { PrismaClient, Division, Posicion, AccionPuntuacion, ResultadoPartido } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'
import * as fs from 'fs'
import * as path from 'path'

const adapter = new PrismaPg({ connectionString: 'postgresql://fantasy_user:fantasy_pass@localhost:5432/fantasy_futbol' })
const prisma = new PrismaClient({ adapter })

// ─── HELPERS ───────────────────────────────────────

function rand(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function prob(p: number) { return Math.random() < p }

function shuffle<T>(arr: T[]): T[] { return [...arr].sort(() => Math.random() - 0.5) }

// ─── IMPORTAR JUGADORES SI FALTAN ──────────────────

async function asegurarJugadores(division: Division, jsonFile: string) {
  const count = await prisma.jugadorEquipo.count({ where: { activo: true, equipo: { division } } })
  if (count >= 80) {
    console.log(`  ✓ Ya hay ${count} jugadores en ${division}`)
    return
  }

  console.log(`  Importando jugadores para ${division} desde ${jsonFile}...`)
  const filePath = path.resolve(__dirname, '../../', jsonFile)
  if (!fs.existsSync(filePath)) { console.log(`  ⚠ No se encontró ${jsonFile}, saltando`); return }

  const datos = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  for (const entrada of datos) {
    let equipo = await prisma.equipo.findFirst({ where: { nombre: entrada.equipo.nombre, division: entrada.equipo.division as Division } })
    if (!equipo) {
      equipo = await prisma.equipo.create({ data: { nombre: entrada.equipo.nombre, division: entrada.equipo.division as Division } })
    }
    for (const j of entrada.jugadores) {
      const jugador = await prisma.jugador.create({
        data: {
          nombreCompleto: j.nombreCompleto,
          nombre: j.nombre,
          dorsal: j.dorsal ?? undefined,
          edad: j.edad ?? undefined,
          posicion: (j.posicion as Posicion) ?? 'UNKNOWN',
          valor: Math.floor(Math.random() * 56) + 5,
        },
      })
      await prisma.jugadorEquipo.create({ data: { jugadorId: jugador.id, equipoId: equipo.id, activo: true } })
    }
  }
  const nuevo = await prisma.jugadorEquipo.count({ where: { activo: true, equipo: { division } } })
  console.log(`  ✓ ${nuevo} jugadores importados para ${division}`)
}

// ─── ASIGNAR JUGADORES INICIALES ───────────────────

const CUPOS: Partial<Record<Posicion, number>> = { PORTERO: 2, DEFENSA: 5, CENTROCAMPISTA: 5, DELANTERO: 4 }

async function asignarPlantilla(miembroLigaId: string, ligaId: string, division: Division) {
  const ocupados = await prisma.plantillaFantasy.findMany({ where: { ligaId }, select: { jugadorId: true } })
  const idsOcupados = ocupados.map(p => p.jugadorId)

  const posiciones = Object.keys(CUPOS) as Posicion[]
  const lotes = await Promise.all(posiciones.map(pos =>
    prisma.jugador.findMany({
      where: { posicion: pos, id: { notIn: idsOcupados }, historialEquipos: { some: { activo: true, equipo: { division } } } },
      take: 20,
    })
  ))

  const seleccionados = posiciones.flatMap((pos, i) => shuffle(lotes[i]).slice(0, CUPOS[pos] ?? 0))
  if (seleccionados.length < 16) throw new Error(`No hay suficientes jugadores libres en ${division}`)

  await prisma.plantillaFantasy.createMany({
    data: seleccionados.map(j => ({ ligaId, miembroLigaId, jugadorId: j.id, precioCompra: j.valor })),
  })
  return seleccionados
}

// ─── PONER 11 TITULARES (formación 4-3-3) ──────────

async function setTitulares(miembroLigaId: string, jugadores: { id: string; posicion: Posicion }[]) {
  const slots: Partial<Record<Posicion, number>> = { PORTERO: 1, DEFENSA: 4, CENTROCAMPISTA: 3, DELANTERO: 3 }
  const titulares: string[] = []
  const conteo: Partial<Record<Posicion, number>> = {}
  const capitanId = jugadores.find(j => j.posicion === 'DELANTERO')?.id ?? jugadores[0].id

  for (const j of shuffle(jugadores)) {
    const max = slots[j.posicion] ?? 0
    const actual = conteo[j.posicion] ?? 0
    if (actual < max) { titulares.push(j.id); conteo[j.posicion] = actual + 1 }
    if (titulares.length === 11) break
  }

  await prisma.titularLiga.deleteMany({ where: { miembroLigaId } })
  await prisma.titularLiga.createMany({ data: titulares.map(jugadorId => ({ miembroLigaId, jugadorId })) })
  await prisma.miembroLiga.update({ where: { id: miembroLigaId }, data: { formacion: '4-3-3', capitanId } })
}

// ─── SIMULAR JORNADA ───────────────────────────────

async function simularJornada(jornadaId: string, division: Division) {
  const jornada = await prisma.jornada.findUnique({ where: { id: jornadaId } })!

  const config = await prisma.configPuntuacion.findMany({ where: { activo: true } })

  function getPuntos(accion: AccionPuntuacion, posicion: Posicion): number {
    return config.find(c => c.accion === accion && c.posicion === posicion)?.puntos
      ?? config.find(c => c.accion === accion && c.posicion === null)?.puntos ?? 0
  }

  const jugadoresEquipo = await prisma.jugadorEquipo.findMany({
    where: { activo: true, equipo: { division } },
    include: { jugador: true },
  })

  const resultadosPorEquipo = new Map<string, ResultadoPartido>()
  const resultados: ResultadoPartido[] = ['VICTORIA', 'EMPATE', 'DERROTA']

  const estadisticas = []
  for (const je of jugadoresEquipo) {
    if (!resultadosPorEquipo.has(je.equipoId)) resultadosPorEquipo.set(je.equipoId, resultados[rand(0, 2)])
    const resultado = resultadosPorEquipo.get(je.equipoId)!
    const convocado = prob(0.75)
    const titular = convocado && prob(0.65)
    const minutosJugados = titular ? rand(45, 95) : convocado && prob(0.4) ? rand(1, 44) : 0
    const goles = minutosJugados > 0 ? (prob(0.12) ? rand(1, 2) : 0) : 0
    const tarjetasAmarillas = minutosJugados > 0 ? (prob(0.15) ? 1 : 0) : 0
    const tarjetaRoja = minutosJugados > 0 && !tarjetasAmarillas && prob(0.03)

    const desglose: Record<string, unknown> = {}
    let total = 0
    const pos = je.jugador.posicion

    if (convocado) { const p = getPuntos('CONVOCADO', pos); desglose.convocado = p; total += p }
    if (titular) { const p = getPuntos('TITULAR', pos); desglose.titular = p; total += p }
    if (minutosJugados > 60) { const p = getPuntos('MINUTOS_60', pos); desglose.minutos60 = p; total += p }
    if (goles > 0) { const u = getPuntos('GOL', pos); const t = u * goles; desglose.goles = { cantidad: goles, puntosUnitarios: u, total: t }; total += t }
    if (tarjetasAmarillas > 0) { const u = getPuntos('TARJETA_AMARILLA', pos); const t = u * tarjetasAmarillas; desglose.tarjetasAmarillas = { cantidad: tarjetasAmarillas, puntosUnitarios: u, total: t }; total += t }
    if (tarjetaRoja) { const p = getPuntos('TARJETA_ROJA', pos); desglose.tarjetaRoja = p; total += p }
    const accionRes: AccionPuntuacion = resultado === 'VICTORIA' ? 'VICTORIA' : resultado === 'EMPATE' ? 'EMPATE' : 'DERROTA'
    const pRes = getPuntos(accionRes, pos); desglose.resultado = { tipo: resultado, puntos: pRes }; total += pRes

    estadisticas.push({ jornadaId, jugadorEquipoId: je.id, convocado, titular, minutosJugados, goles, tarjetasAmarillas, tarjetaRoja, resultado, puntosCalculados: total, desglose: desglose as any })
  }
  await prisma.estadisticaJornada.createMany({ data: estadisticas, skipDuplicates: true })
  return estadisticas.length
}

async function generarSnapshot(jornadaId: string, division: Division) {
  const ligas = await prisma.liga.findMany({ where: { division } })
  const ligaIds = ligas.map(l => l.id)
  const miembros = await prisma.miembroLiga.findMany({
    where: { ligaId: { in: ligaIds } },
    include: {
      titulares: {
        include: { jugador: { include: { historialEquipos: { where: { activo: true }, take: 1 } } } },
      },
    },
  })

  const snapshots = []
  for (const m of miembros) {
    for (const t of m.titulares) {
      const je = t.jugador.historialEquipos[0]
      if (!je) continue
      snapshots.push({ jornadaId, miembroLigaId: m.id, jugadorEquipoId: je.id, esCapitan: m.capitanId === t.jugadorId })
    }
  }
  await prisma.snapshotAlineacion.createMany({ data: snapshots, skipDuplicates: true })
  return snapshots.length
}

async function calcularPuntuaciones(jornadaId: string) {
  const snapshots = await prisma.snapshotAlineacion.findMany({ where: { jornadaId } })
  const estadisticas = await prisma.estadisticaJornada.findMany({ where: { jornadaId } })
  const statsMap = new Map(estadisticas.map(e => [e.jugadorEquipoId, e]))

  const porMiembro = new Map<string, typeof snapshots>()
  for (const s of snapshots) {
    if (!porMiembro.has(s.miembroLigaId)) porMiembro.set(s.miembroLigaId, [])
    porMiembro.get(s.miembroLigaId)!.push(s)
  }

  for (const [miembroLigaId, snaps] of porMiembro) {
    let total = 0
    for (const s of snaps) {
      const stats = statsMap.get(s.jugadorEquipoId)
      if (!stats) continue
      total += s.esCapitan ? stats.puntosCalculados * 2 : stats.puntosCalculados
    }
    await prisma.puntuacionJornada.upsert({
      where: { jornadaId_miembroLigaId: { jornadaId, miembroLigaId } },
      update: { puntos: total },
      create: { jornadaId, miembroLigaId, puntos: total },
    })
    await prisma.miembroLiga.update({ where: { id: miembroLigaId }, data: { puntuacion: { increment: total } } })
  }
}

// ─── MAIN ──────────────────────────────────────────

async function main() {
  console.log('🧹 Limpiando datos de demo anteriores...')
  await prisma.puntuacionJornada.deleteMany()
  await prisma.estadisticaJornada.deleteMany()
  await prisma.snapshotAlineacion.deleteMany()
  await prisma.jornada.deleteMany()
  await prisma.transferencia.deleteMany()
  await prisma.puja.deleteMany()
  await prisma.ofertaMercado.deleteMany()
  await prisma.titularLiga.deleteMany()
  await prisma.plantillaFantasy.deleteMany()
  await prisma.miembroLiga.deleteMany()
  await prisma.liga.deleteMany()
  await prisma.usuario.deleteMany()

  // ── Jugadores ──────────────────────────────────
  console.log('\n⚽ Asegurando jugadores en BD...')
  await asegurarJugadores('RFEF3_GRUPO_IV', 'jugadores_3rfef.json')
  await asegurarJugadores('RFEF2_GRUPO_II', 'jugadores_2rfef.json')

  // ── Usuarios ───────────────────────────────────
  console.log('\n👤 Creando usuarios...')
  const pass = await bcrypt.hash('demo123', 10)
  const [sergio, mikel, iker, june, unai] = await Promise.all([
    prisma.usuario.create({ data: { email: 'sergio@demo.com', username: 'Sergio', contrasena: pass, esAdmin: true } }),
    prisma.usuario.create({ data: { email: 'mikel@demo.com',  username: 'Mikel',  contrasena: pass } }),
    prisma.usuario.create({ data: { email: 'iker@demo.com',   username: 'Iker',   contrasena: pass } }),
    prisma.usuario.create({ data: { email: 'june@demo.com',   username: 'June',   contrasena: pass } }),
    prisma.usuario.create({ data: { email: 'unai@demo.com',   username: 'Unai',   contrasena: pass } }),
  ])
  console.log('  ✓ 5 usuarios (contraseña: demo123)')

  // ── Liga 3ª RFEF ────────────────────────────────
  console.log('\n🏆 Creando Liga 3ª RFEF - Temporada 25/26...')
  const liga3 = await prisma.liga.create({
    data: {
      nombre: 'Liga 3ª RFEF - Temporada 25/26',
      creadorId: sergio.id,
      division: 'RFEF3_GRUPO_IV',
      publica: true,
      maxEquipos: 8,
      presupuestoInicial: 100,
    },
  })

  for (const usuario of [sergio, mikel, iker, june]) {
    const miembro = await prisma.miembroLiga.create({
      data: { ligaId: liga3.id, usuarioId: usuario.id, presupuestoRestante: 100 },
    })
    const jugadores = await asignarPlantilla(miembro.id, liga3.id, 'RFEF3_GRUPO_IV')
    await setTitulares(miembro.id, jugadores)
    console.log(`  ✓ ${usuario.username} — plantilla y alineación asignadas`)
  }

  // ── Liga 2ª RFEF ────────────────────────────────
  console.log('\n🏆 Creando Liga 2ª RFEF - Privada...')
  const liga2 = await prisma.liga.create({
    data: {
      nombre: 'La Peña 2ª RFEF',
      creadorId: unai.id,
      division: 'RFEF2_GRUPO_II',
      publica: false,
      codigoInvitacion: 'DEMO2024',
      maxEquipos: 6,
      presupuestoInicial: 80,
    },
  })

  for (const usuario of [unai, mikel, iker]) {
    const miembro = await prisma.miembroLiga.create({
      data: { ligaId: liga2.id, usuarioId: usuario.id, presupuestoRestante: 80 },
    })
    const jugadores = await asignarPlantilla(miembro.id, liga2.id, 'RFEF2_GRUPO_II')
    await setTitulares(miembro.id, jugadores)
    console.log(`  ✓ ${usuario.username} — plantilla y alineación asignadas`)
  }

  // ── Jornadas y puntuaciones ─────────────────────
  console.log('\n📅 Simulando 3 jornadas...')
  const hoy = new Date()

  for (const { division, ligaNombre, numJornadas } of [
    { division: 'RFEF3_GRUPO_IV' as Division, ligaNombre: 'Liga 3ª RFEF', numJornadas: 3 },
    { division: 'RFEF2_GRUPO_II' as Division, ligaNombre: 'La Peña 2ª RFEF', numJornadas: 3 },
  ]) {
    for (let n = 1; n <= numJornadas; n++) {
      const fechaInicioJornada = new Date(hoy)
      fechaInicioJornada.setDate(hoy.getDate() - (numJornadas - n + 1) * 7)

      const jornada = await prisma.jornada.create({
        data: { division, numJornada: n, fechaInicioJornada },
      })

      const snapshots = await generarSnapshot(jornada.id, division)
      const stats     = await simularJornada(jornada.id, division)
      await calcularPuntuaciones(jornada.id)

      console.log(`  ✓ ${ligaNombre} — Jornada ${n}: ${snapshots} snapshots, ${stats} estadísticas`)
    }
  }

  // ── Mercado: algunas ofertas activas ────────────
  console.log('\n💰 Creando algunas ofertas en el mercado...')
  const miembros3 = await prisma.miembroLiga.findMany({
    where: { ligaId: liga3.id },
    include: { plantillaFantasy: { take: 2 } },
  })
  for (const m of miembros3.slice(0, 2)) {
    const jugadorParaVender = m.plantillaFantasy[1]
    if (jugadorParaVender) {
      const jugador = await prisma.jugador.findUnique({ where: { id: jugadorParaVender.jugadorId } })
      await prisma.ofertaMercado.create({
        data: {
          ligaId: liga3.id,
          jugadorId: jugadorParaVender.jugadorId,
          vendedorId: m.id,
          precioMinimo: jugador?.valor ?? 10,
          estado: 'ACTIVA',
        },
      })
    }
  }
  console.log('  ✓ 2 ofertas activas en el mercado')

  // ── Resumen ─────────────────────────────────────
  console.log('\n✅ Seed de demo completado')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('Usuarios (contraseña: demo123)')
  console.log('  sergio@demo.com  (admin)')
  console.log('  mikel@demo.com')
  console.log('  iker@demo.com')
  console.log('  june@demo.com')
  console.log('  unai@demo.com')
  console.log('Ligas:')
  console.log('  "Liga 3ª RFEF - Temporada 25/26" — pública — 4 miembros')
  console.log('  "La Peña 2ª RFEF" — privada — código: DEMO2024 — 3 miembros')
  console.log('Jornadas: 3 simuladas por división con puntuaciones calculadas')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
