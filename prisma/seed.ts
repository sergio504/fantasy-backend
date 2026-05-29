import { PrismaClient, Division, Posicion } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { asignarJugadoresIniciales } from '../src/controllers/league.controller'

const adapter = new PrismaPg({ connectionString: 'postgresql://fantasy_user:fantasy_pass@localhost:5432/fantasy_futbol' })
const prisma = new PrismaClient({ adapter })

// ─── GENERADOR DE JUGADORES ────────────────────────

const NOMBRES = [
  'Carlos', 'Marcos', 'Iván', 'Pedro', 'Raúl', 'Sergio', 'Tomás', 'Adrián', 'Javier', 'Luis',
  'Diego', 'Miguel', 'Antonio', 'Rubén', 'Óscar', 'Álvaro', 'Gonzalo', 'Mateo', 'Fernando', 'Nicolás',
  'David', 'Pablo', 'Roberto', 'Cristian', 'Hugo', 'Andrés', 'Víctor', 'Samuel', 'Jorge', 'Ignacio',
  'Emilio', 'Borja', 'Kike', 'Noel', 'Aaron', 'Alex', 'Mario', 'Jaime', 'Nacho', 'Toni',
  'Dani', 'Santi', 'Fran', 'Iker', 'Joseba', 'Mikel', 'Unai', 'Asier', 'Oier', 'Rafa',
  'Chema', 'Tito', 'Paco', 'Manolo', 'Curro', 'Pepe', 'Lolo', 'Juanma', 'Sebas', 'Fito',
  'Quique', 'Charly', 'Pipe', 'Richi', 'Edu', 'Suso', 'Nano', 'Manu', 'Vicent', 'Xavi',
  'Gerard', 'Roger', 'Marc', 'Joel', 'Eric', 'Pol', 'Arnau', 'Jan', 'Oriol', 'Pau',
]

const APELLIDOS = [
  'Vidal', 'Rueda', 'Correa', 'Lomas', 'Peña', 'Blanco', 'Cano', 'Mora', 'Soto', 'Reyes',
  'Parra', 'Fuentes', 'Vargas', 'Castro', 'Nieto', 'Ramos', 'Ibáñez', 'Herrera', 'Gil', 'Torres',
  'Molina', 'Ortega', 'Vega', 'Lara', 'Prieto', 'Moya', 'Salas', 'Campos', 'Espejo', 'Robles',
  'Crespo', 'Delgado', 'Santana', 'Aguilar', 'Romero', 'Medina', 'Rubio', 'Arias', 'Serrano', 'Cabrera',
  'Méndez', 'Bravo', 'Iglesias', 'Lorenzo', 'Navarro', 'Uribe', 'Aranda', 'Benito', 'Zamora', 'Pedraza',
  'Giménez', 'Pascual', 'Guerrero', 'Morales', 'Esteve', 'Nadal', 'Solano', 'Castaño', 'Espinosa', 'Ríos',
  'García', 'López', 'Martínez', 'González', 'Rodríguez', 'Fernández', 'Sánchez', 'Pérez', 'Gómez', 'Díaz',
  'Jiménez', 'Hernández', 'Álvarez', 'Muñoz', 'Alonso', 'Gutiérrez', 'Domínguez', 'Vázquez', 'Palomo', 'Marín',
]

const CONFIG_DIVISIONES: Record<Division, { equipos: string[]; valorBase: number }> = {
  A: {
    equipos: ['FC Norte', 'Atlético Sur', 'Real Oeste', 'Deportivo Este', 'CD Central'],
    valorBase: 8,
  },
  B: {
    equipos: ['CD Montaña', 'UD Ribera', 'SD Llanos', 'CF Valles', 'AD Bosque'],
    valorBase: 5,
  },
  C: {
    equipos: ['Peña Roja', 'Atlético Pinar', 'CF Cerro', 'UD Cantera', 'SD Barrio'],
    valorBase: 2,
  },
}

// Cuántos jugadores por posición para tener capacidad para N equipos × 16 jugadores
// 5 equipos × 2 POR = 10, × 5 DEF = 25, × 5 CEN = 25, × 4 DEL = 20 → 80 por división
const CUOTA_SEED = { PORTERO: 10, DEFENSA: 25, CENTROCAMPISTA: 25, DELANTERO: 20 }

function generarJugadoresDivision(
  division: Division
): { nombre: string; posicion: Posicion; equipoReal: string; valor: number }[] {
  const { equipos, valorBase } = CONFIG_DIVISIONES[division]
  const resultado = []
  let idx = 0

  const VALOR_POS: Record<string, number> = {
    PORTERO: valorBase, DEFENSA: valorBase + 1,
    CENTROCAMPISTA: valorBase + 2, DELANTERO: valorBase + 4,
  }

  for (const [posicion, cantidad] of Object.entries(CUOTA_SEED)) {
    for (let i = 0; i < cantidad; i++) {
      const nombre = `${NOMBRES[idx % NOMBRES.length]} ${APELLIDOS[Math.floor(idx / NOMBRES.length) % APELLIDOS.length]}`
      const equipoReal = equipos[i % equipos.length]
      const variacion = Math.floor(i / equipos.length)
      resultado.push({
        nombre,
        posicion: posicion as Posicion,
        equipoReal,
        valor: Math.max(1, VALOR_POS[posicion] - variacion),
      })
      idx++
    }
  }

  return resultado
}

async function main() {
  console.log('🌱 Limpiando base de datos...')
  await prisma.transferencia.deleteMany()
  await prisma.puja.deleteMany()
  await prisma.ofertaMercado.deleteMany()
  await prisma.titularLiga.deleteMany()
  await prisma.jugadorEquipo.deleteMany()
  await prisma.miembroLiga.deleteMany()
  await prisma.liga.deleteMany()
  await prisma.jugador.deleteMany()
  await prisma.usuario.deleteMany()

  console.log('⚽ Creando jugadores...')
  let totalJugadores = 0
  for (const div of ['A', 'B', 'C'] as Division[]) {
    const lista = generarJugadoresDivision(div)
    for (const j of lista) {
      await prisma.jugador.create({ data: { ...j, division: div } })
    }
    totalJugadores += lista.length
    console.log(`   División ${div}: ${lista.length} jugadores`)
  }
  console.log(`   Total: ${totalJugadores} jugadores (${totalJugadores / 3} por división)`)

  console.log('👤 Creando usuarios...')
  const contrasena = await bcrypt.hash('password123', 10)
  const usuarios = await Promise.all([
    prisma.usuario.create({ data: { email: 'jugador1@test.com', username: 'Jugador1', contrasena } }),
    prisma.usuario.create({ data: { email: 'jugador2@test.com', username: 'Jugador2', contrasena } }),
    prisma.usuario.create({ data: { email: 'jugador3@test.com', username: 'Jugador3', contrasena } }),
    prisma.usuario.create({ data: { email: 'jugador4@test.com', username: 'Jugador4', contrasena } }),
    prisma.usuario.create({ data: { email: 'jugador5@test.com', username: 'Jugador5', contrasena } }),
  ])
  console.log(`   ${usuarios.length} usuarios (contraseña: password123)`)

  console.log('🏆 Creando ligas...')

  // Liga A pública — 3 miembros (3 × 16 = 48 jugadores únicos necesarios, tenemos 80)
  await prisma.$transaction(async tx => {
    const liga = await tx.liga.create({
      data: {
        nombre: 'Liga División A - Temporada 1',
        creadorId: usuarios[0].id,
        division: 'A',
        publica: true,
        maxEquipos: 8,
        presupuestoInicial: 100,
        miembros: {
          create: [
            { usuarioId: usuarios[0].id, presupuestoRestante: 100 },
            { usuarioId: usuarios[1].id, presupuestoRestante: 100 },
            { usuarioId: usuarios[2].id, presupuestoRestante: 100 },
          ],
        },
      },
      include: { miembros: true },
    })
    for (const m of liga.miembros) {
      await asignarJugadoresIniciales(m.id, liga.id, 'A', tx)
    }
    console.log(`   "${liga.nombre}" — 3 equipos`)
  })

  // Liga B privada — 2 miembros
  const codigoB = crypto.randomBytes(6).toString('hex')
  await prisma.$transaction(async tx => {
    const liga = await tx.liga.create({
      data: {
        nombre: 'Liga Privada División B',
        creadorId: usuarios[2].id,
        division: 'B',
        publica: false,
        codigoInvitacion: codigoB,
        maxEquipos: 6,
        presupuestoInicial: 80,
        miembros: {
          create: [
            { usuarioId: usuarios[2].id, presupuestoRestante: 80 },
            { usuarioId: usuarios[3].id, presupuestoRestante: 80 },
          ],
        },
      },
      include: { miembros: true },
    })
    for (const m of liga.miembros) {
      await asignarJugadoresIniciales(m.id, liga.id, 'B', tx)
    }
    console.log(`   "${liga.nombre}" — código: ${codigoB}`)
  })

  // Liga C pública — 2 miembros
  await prisma.$transaction(async tx => {
    const liga = await tx.liga.create({
      data: {
        nombre: 'Liga División C - Cantera',
        creadorId: usuarios[3].id,
        division: 'C',
        publica: true,
        maxEquipos: 10,
        presupuestoInicial: 60,
        miembros: {
          create: [
            { usuarioId: usuarios[3].id, presupuestoRestante: 60 },
            { usuarioId: usuarios[4].id, presupuestoRestante: 60 },
          ],
        },
      },
      include: { miembros: true },
    })
    for (const m of liga.miembros) {
      await asignarJugadoresIniciales(m.id, liga.id, 'C', tx)
    }
    console.log(`   "${liga.nombre}" — 2 equipos`)
  })

  console.log('\n✅ Seed completado')
  console.log('   Usuarios: jugador1@test.com ... jugador5@test.com')
  console.log('   Contraseña de todos: password123')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
