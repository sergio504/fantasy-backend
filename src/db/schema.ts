import {
  mysqlTable, varchar, int, boolean, datetime, json, mysqlEnum, uniqueIndex, index, text,
} from 'drizzle-orm/mysql-core'
import { relations } from 'drizzle-orm'

// ─── ENUMS ─────────────────────────────────────────

export const divisionValues    = ['RFEF2_GRUPO_II', 'RFEF3_GRUPO_IV', 'HONOR_BIZKAIA'] as const

export const divisiones = mysqlTable('divisiones', {
  id:              varchar('id', { length: 36 }).primaryKey(),
  division:        mysqlEnum('division', divisionValues).notNull().unique(),
  nombre:          varchar('nombre', { length: 255 }).notNull(),
  temporada:       varchar('temporada', { length: 10 }).notNull(),
  urlCalendario:   varchar('urlCalendario', { length: 500 }).notNull(),
  carpetaArchivos: varchar('carpetaArchivos', { length: 100 }).notNull(),
  activa:          boolean('activa').notNull().default(true),
  creadoEn:        datetime('creadoEn').notNull(),
})
export const posicionValues    = ['PORTERO', 'DEFENSA', 'CENTROCAMPISTA', 'DELANTERO', 'UNKNOWN'] as const
export const estadoOfertaValues = ['ACTIVA', 'VENDIDA', 'CANCELADA'] as const
export const tipoAccionAdminValues = [
  'CREAR_JUGADOR', 'EDITAR_JUGADOR', 'CREAR_FICHAJE', 'CERRAR_FICHAJE',
  'EDITAR_ESTADISTICA', 'ACTUALIZAR_CONFIG', 'CREAR_JORNADA', 'GENERAR_SNAPSHOT',
  'SIMULAR_JORNADA', 'CALCULAR_PUNTUACIONES',
] as const
export const accionPuntuacionValues = [
  'CONVOCADO', 'JUEGA', 'TITULAR', 'MINUTOS_60',
  'GOL', 'GOL_PENALTY', 'GOL_PROPIA',
  'GOL_A_FAVOR', 'GOL_ENCAJADO',
  'VICTORIA', 'EMPATE', 'DERROTA',
  'GOLEADA_FAVOR', 'GOLEADA_CONTRA',
  'TARJETA_AMARILLA', 'DOBLE_AMARILLA', 'TARJETA_ROJA',
] as const
export const resultadoPartidoValues = ['VICTORIA', 'EMPATE', 'DERROTA'] as const

export type Division        = typeof divisionValues[number]
export type Posicion        = typeof posicionValues[number]
export type AccionPuntuacion = typeof accionPuntuacionValues[number]
export type ResultadoPartido = typeof resultadoPartidoValues[number]
export type TipoAccionAdmin  = typeof tipoAccionAdminValues[number]

// ─── TABLAS ─────────────────────────────────────────

export const usuario = mysqlTable('usuario', {
  id:           varchar('id', { length: 36 }).primaryKey(),
  email:        varchar('email', { length: 255 }).notNull().unique(),
  username:     varchar('username', { length: 255 }).notNull().unique(),
  contrasena:   varchar('contrasena', { length: 255 }).notNull(),
  creadoEn:     datetime('creadoEn').notNull(),
  ultimoAcceso: datetime('ultimoAcceso'),
  esAdmin:      boolean('esAdmin').notNull().default(false),
  activo:       boolean('activo').notNull().default(true),
})

export const liga = mysqlTable('liga', {
  id:                 varchar('id', { length: 36 }).primaryKey(),
  nombre:             varchar('nombre', { length: 255 }).notNull(),
  creadorId:          varchar('creadorId', { length: 36 }).notNull(),
  division:           mysqlEnum('division', divisionValues).notNull(),
  publica:            boolean('publica').notNull().default(true),
  codigoInvitacion:   varchar('codigoInvitacion', { length: 20 }).unique(),
  maxEquipos:         int('maxEquipos').notNull().default(10),
  presupuestoInicial: int('presupuestoInicial').notNull().default(100),
  creadoEn:           datetime('creadoEn').notNull(),
})

export const miembroLiga = mysqlTable('miembroLiga', {
  id:                  varchar('id', { length: 36 }).primaryKey(),
  ligaId:              varchar('ligaId', { length: 36 }).notNull(),
  usuarioId:           varchar('usuarioId', { length: 36 }).notNull(),
  presupuestoRestante: int('presupuestoRestante').notNull().default(100),
  puntuacion:          int('puntuacion').notNull().default(0),
  formacion:           varchar('formacion', { length: 10 }),
  capitanId:           varchar('capitanId', { length: 36 }),
  creadoEn:            datetime('creadoEn').notNull(),
}, t => ({
  ligaUsuarioUniq: uniqueIndex('ml_liga_usuario').on(t.ligaId, t.usuarioId),
}))

export const equipo = mysqlTable('equipo', {
  id:       varchar('id', { length: 36 }).primaryKey(),
  nombre:   varchar('nombre', { length: 255 }).notNull(),
  division: mysqlEnum('division', divisionValues).notNull(),
  creadoEn: datetime('creadoEn').notNull(),
})

export const jugador = mysqlTable('jugador', {
  id:              varchar('id', { length: 36 }).primaryKey(),
  nombreCompleto:  varchar('nombreCompleto', { length: 255 }).notNull(),
  nombre:          varchar('nombre', { length: 100 }).notNull(),
  dorsal:          int('dorsal'),
  fechaNacimiento: datetime('fechaNacimiento'),
  edad:            int('edad'),
  posicion:        mysqlEnum('posicion', posicionValues).notNull(),
  valor:           int('valor').notNull().default(0),
  creadoEn:        datetime('creadoEn').notNull(),
})

export const jugadorEquipo = mysqlTable('jugadorEquipo', {
  id:        varchar('id', { length: 36 }).primaryKey(),
  jugadorId: varchar('jugadorId', { length: 36 }).notNull(),
  equipoId:  varchar('equipoId', { length: 36 }).notNull(),
  desde:     datetime('desde').notNull(),
  hasta:     datetime('hasta'),
  activo:    boolean('activo').notNull().default(true),
  creadoEn:  datetime('creadoEn').notNull(),
}, t => ({
  jugadorIdx:    index('je_jugador').on(t.jugadorId),
  equipoActivoIdx: index('je_equipo_activo').on(t.equipoId, t.activo),
}))

export const plantillaFantasy = mysqlTable('plantillaFantasy', {
  id:              varchar('id', { length: 36 }).primaryKey(),
  ligaId:          varchar('ligaId', { length: 36 }).notNull(),
  miembroLigaId:   varchar('miembroLigaId', { length: 36 }).notNull(),
  jugadorId:       varchar('jugadorId', { length: 36 }).notNull(),
  precioCompra:    int('precioCompra').notNull(),
  clausula:        int('clausula').notNull().default(0),
  jornadasBloqueo: int('jornadasBloqueo').notNull().default(3),
  creadoEn:        datetime('creadoEn').notNull(),
}, t => ({
  ligaJugadorUniq: uniqueIndex('pf_liga_jugador').on(t.ligaId, t.jugadorId),
}))

export const clausulazoPendiente = mysqlTable('clausulazoPendiente', {
  id:                 varchar('id', { length: 36 }).primaryKey(),
  ligaId:             varchar('ligaId', { length: 36 }).notNull(),
  jugadorId:          varchar('jugadorId', { length: 36 }).notNull(),
  compradorMiembroId: varchar('compradorMiembroId', { length: 36 }).notNull(),
  vendedorMiembroId:  varchar('vendedorMiembroId', { length: 36 }).notNull(),
  importe:            int('importe').notNull(),
  creadoEn:           datetime('creadoEn').notNull(),
}, t => ({
  ligaJugadorUniq: uniqueIndex('cp_liga_jugador').on(t.ligaId, t.jugadorId),
}))

export const titularLiga = mysqlTable('titularLiga', {
  id:            varchar('id', { length: 36 }).primaryKey(),
  miembroLigaId: varchar('miembroLigaId', { length: 36 }).notNull(),
  jugadorId:     varchar('jugadorId', { length: 36 }).notNull(),
}, t => ({
  miembroJugadorUniq: uniqueIndex('tl_miembro_jugador').on(t.miembroLigaId, t.jugadorId),
}))

export const ofertaMercado = mysqlTable('ofertaMercado', {
  id:             varchar('id', { length: 36 }).primaryKey(),
  ligaId:         varchar('ligaId', { length: 36 }).notNull(),
  jugadorId:      varchar('jugadorId', { length: 36 }).notNull(),
  vendedorId:     varchar('vendedorId', { length: 36 }),
  precioMinimo:   int('precioMinimo').notNull(),
  estado:         mysqlEnum('estado', estadoOfertaValues).notNull().default('ACTIVA'),
  fechaCaducidad: datetime('fechaCaducidad'),
  creadoEn:       datetime('creadoEn').notNull(),
})

export const puja = mysqlTable('puja', {
  id:              varchar('id', { length: 36 }).primaryKey(),
  ofertaMercadoId: varchar('ofertaMercadoId', { length: 36 }).notNull(),
  miembroLigaId:   varchar('miembroLigaId', { length: 36 }).notNull(),
  cantidad:        int('cantidad').notNull(),
  creadoEn:        datetime('creadoEn').notNull(),
}, t => ({
  ofertaMiembroUniq: uniqueIndex('puja_oferta_miembro').on(t.ofertaMercadoId, t.miembroLigaId),
}))

export const historialAdmin = mysqlTable('historialAdmin', {
  id:           varchar('id', { length: 36 }).primaryKey(),
  adminId:      varchar('adminId', { length: 36 }).notNull(),
  accion:       mysqlEnum('accion', tipoAccionAdminValues).notNull(),
  entidad:      varchar('entidad', { length: 100 }).notNull(),
  entidadId:    varchar('entidadId', { length: 100 }).notNull(),
  datosAntes:   json('datosAntes'),
  datosDespues: json('datosDespues').notNull(),
  creadoEn:     datetime('creadoEn').notNull(),
})

export const jornada = mysqlTable('jornada', {
  id:                        varchar('id', { length: 36 }).primaryKey(),
  division:                  mysqlEnum('division', divisionValues).notNull(),
  numJornada:                int('numJornada').notNull(),
  fechaInicioJornada:        datetime('fechaInicioJornada'),
  fechaFinJornada:           datetime('fechaFinJornada'),
  fechaImportacion:          datetime('fechaImportacion'),
  snapshotGenerado:          boolean('snapshotGenerado').notNull().default(false),
  statsImportadas:           boolean('statsImportadas').notNull().default(false),
  puntosPorJugadorCalculados: boolean('puntosPorJugadorCalculados').notNull().default(false),
  puntuacionesCalculadas:    boolean('puntuacionesCalculadas').notNull().default(false),
}, t => ({
  divisionJornadaUniq: uniqueIndex('j_division_num').on(t.division, t.numJornada),
}))

export const snapshotAlineacion = mysqlTable('snapshotAlineacion', {
  id:              varchar('id', { length: 36 }).primaryKey(),
  jornadaId:       varchar('jornadaId', { length: 36 }).notNull(),
  miembroLigaId:   varchar('miembroLigaId', { length: 36 }).notNull(),
  jugadorEquipoId: varchar('jugadorEquipoId', { length: 36 }).notNull(),
  esCapitan:       boolean('esCapitan').notNull().default(false),
  creadoEn:        datetime('creadoEn').notNull(),
}, t => ({
  jornadaMiembroJugadorUniq: uniqueIndex('sa_jornada_miembro_jugador').on(t.jornadaId, t.miembroLigaId, t.jugadorEquipoId),
}))

export const transferencia = mysqlTable('transferencia', {
  id:          varchar('id', { length: 36 }).primaryKey(),
  jugadorId:   varchar('jugadorId', { length: 36 }).notNull(),
  ligaId:      varchar('ligaId', { length: 36 }).notNull(),
  vendedorId:  varchar('vendedorId', { length: 36 }),
  compradorId: varchar('compradorId', { length: 36 }).notNull(),
  ofertaId:    varchar('ofertaId', { length: 36 }).unique(),
  precio:      int('precio').notNull(),
  fecha:       datetime('fecha').notNull(),
})

export const aliasEquipo = mysqlTable('aliasEquipo', {
  id:       varchar('id', { length: 36 }).primaryKey(),
  equipoId: varchar('equipoId', { length: 36 }).notNull(),
  alias:    varchar('alias', { length: 255 }).notNull().unique(),
})

export const aliasJugador = mysqlTable('aliasJugador', {
  id:        varchar('id', { length: 36 }).primaryKey(),
  jugadorId: varchar('jugadorId', { length: 36 }).notNull(),
  alias:     varchar('alias', { length: 255 }).notNull().unique(),
})

export const motivoPenalizacionValues = ['SALDO_NEGATIVO', 'ALINEACION_INCOMPLETA'] as const
export type MotivoPenalizacion = typeof motivoPenalizacionValues[number]

export const penalizacionJornada = mysqlTable('penalizacionJornada', {
  id:            varchar('id', { length: 36 }).primaryKey(),
  jornadaId:     varchar('jornadaId', { length: 36 }).notNull(),
  miembroLigaId: varchar('miembroLigaId', { length: 36 }).notNull(),
  motivo:        mysqlEnum('motivo', motivoPenalizacionValues).notNull(),
}, t => ({
  uniq: uniqueIndex('pj_jornada_miembro_pen').on(t.jornadaId, t.miembroLigaId),
}))

export const estadisticaJornadaSinRegistrar = mysqlTable('estadisticaJornadaSinRegistrar', {
  id:                    varchar('id', { length: 36 }).primaryKey(),
  jornadaId:             varchar('jornadaId', { length: 36 }).notNull(),
  equipoId:              varchar('equipoId', { length: 36 }),
  nombreEquipoScraper:   varchar('nombreEquipoScraper', { length: 255 }).notNull(),
  nombreJugadorScraper:  varchar('nombreJugadorScraper', { length: 255 }).notNull(),
  nombreCompletoScraper: varchar('nombreCompletoScraper', { length: 255 }).notNull(),
  convocado:             boolean('convocado').notNull().default(false),
  titular:               boolean('titular').notNull().default(false),
  minutosJugados:        int('minutosJugados').notNull().default(0),
  goles:                 int('goles').notNull().default(0),
  golesDePenalti:        int('golesDePenalti').notNull().default(0),
  tarjetasAmarillas:     int('tarjetasAmarillas').notNull().default(0),
  tarjetaRoja:           boolean('tarjetaRoja').notNull().default(false),
  resultado:             mysqlEnum('resultado', resultadoPartidoValues).notNull().default('DERROTA'),
  golesEncajados:        int('golesEncajados').notNull().default(0),
  golesAFavor:           int('golesAFavor').notNull().default(0),
  golEnPropia:           int('golEnPropia').notNull().default(0),
  diferenciaGoles:       int('diferenciaGoles').notNull().default(0),
  creadoEn:              datetime('creadoEn').notNull(),
})

export const configEconomia = mysqlTable('configEconomia', {
  id:          varchar('id', { length: 36 }).primaryKey(),
  clave:       varchar('clave', { length: 50 }).notNull().unique(),
  valor:       int('valor').notNull(),
  descripcion: varchar('descripcion', { length: 255 }),
})

export const configRevalorizacion = mysqlTable('configRevalorizacion', {
  id:           varchar('id', { length: 36 }).primaryKey(),
  puntosHasta:  int('puntosHasta'),
  porcentaje:   int('porcentaje').notNull(),
  orden:        int('orden').notNull(),
  descripcion:  varchar('descripcion', { length: 255 }),
})

export const conceptoSaldoValues = [
  'PRESUPUESTO_INICIAL', 'COMPRA_MERCADO', 'VENTA_MERCADO',
  'VENTA_RAPIDA', 'CLAUSULAZO_PAGO', 'CLAUSULAZO_COBRO', 'INVERSION_CLAUSULA',
] as const
export type ConceptoSaldo = typeof conceptoSaldoValues[number]

export const motivoClausulaValues = [
  'ADQUISICION', 'INVERSION', 'CLAUSULAZO_NUEVO_DUENO',
] as const
export type MotivoClausula = typeof motivoClausulaValues[number]

export const tipoHistorialConfigValues = [
  'PUNTUACION', 'ECONOMIA', 'REVALORIZACION',
] as const
export type TipoHistorialConfig = typeof tipoHistorialConfigValues[number]

export const historialSaldo = mysqlTable('historialSaldo', {
  id:              varchar('id', { length: 36 }).primaryKey(),
  miembroLigaId:   varchar('miembroLigaId', { length: 36 }).notNull(),
  ligaId:          varchar('ligaId', { length: 36 }).notNull(),
  concepto:        mysqlEnum('concepto', conceptoSaldoValues).notNull(),
  importe:         int('importe').notNull(),
  saldoResultante: int('saldoResultante').notNull(),
  descripcion:     varchar('descripcion', { length: 200 }),
  jugadorId:       varchar('jugadorId', { length: 36 }),
  numJornada:      int('numJornada'),
  creadoEn:        datetime('creadoEn').notNull(),
}, t => ({
  miembroIdx: index('hs_miembro').on(t.miembroLigaId),
  ligaIdx:    index('hs_liga').on(t.ligaId),
}))

export const historialValorJugador = mysqlTable('historialValorJugador', {
  id:            varchar('id', { length: 36 }).primaryKey(),
  jugadorId:     varchar('jugadorId', { length: 36 }).notNull(),
  valorAnterior: int('valorAnterior').notNull(),
  valorNuevo:    int('valorNuevo').notNull(),
  numJornada:    int('numJornada').notNull(),
  creadoEn:      datetime('creadoEn').notNull(),
}, t => ({
  jugadorIdx: index('hvj_jugador').on(t.jugadorId),
}))

export const historialClausula = mysqlTable('historialClausula', {
  id:               varchar('id', { length: 36 }).primaryKey(),
  jugadorId:        varchar('jugadorId', { length: 36 }).notNull(),
  ligaId:           varchar('ligaId', { length: 36 }).notNull(),
  miembroLigaId:    varchar('miembroLigaId', { length: 36 }).notNull(),
  clausulaAnterior: int('clausulaAnterior').notNull(),
  clausulaNueva:    int('clausulaNueva').notNull(),
  motivo:           mysqlEnum('motivo', motivoClausulaValues).notNull(),
  creadoEn:         datetime('creadoEn').notNull(),
}, t => ({
  jugadorLigaIdx: index('hc_jugador_liga').on(t.jugadorId, t.ligaId),
}))

export const historialConfig = mysqlTable('historialConfig', {
  id:            varchar('id', { length: 36 }).primaryKey(),
  tipo:          mysqlEnum('tipo', tipoHistorialConfigValues).notNull(),
  campo:         varchar('campo', { length: 100 }).notNull(),
  valorAnterior: int('valorAnterior'),
  valorNuevo:    int('valorNuevo').notNull(),
  adminId:       varchar('adminId', { length: 36 }).notNull(),
  creadoEn:      datetime('creadoEn').notNull(),
}, t => ({
  tipoIdx: index('hcfg_tipo').on(t.tipo),
}))

export const configPuntuacion = mysqlTable('configPuntuacion', {
  id:          varchar('id', { length: 36 }).primaryKey(),
  posicion:    mysqlEnum('posicion', posicionValues),
  accion:      mysqlEnum('accion', accionPuntuacionValues).notNull(),
  puntos:      int('puntos').notNull(),
  desde:       datetime('desde').notNull(),
  hasta:       datetime('hasta'),
  activo:      boolean('activo').notNull().default(true),
  descripcion: varchar('descripcion', { length: 255 }),
})

export const estadisticaJornada = mysqlTable('estadisticaJornada', {
  id:               varchar('id', { length: 36 }).primaryKey(),
  jornadaId:        varchar('jornadaId', { length: 36 }).notNull(),
  jugadorEquipoId:  varchar('jugadorEquipoId', { length: 36 }).notNull(),
  convocado:        boolean('convocado').notNull().default(false),
  titular:          boolean('titular').notNull().default(false),
  minutosJugados:   int('minutosJugados').notNull().default(0),
  goles:            int('goles').notNull().default(0),
  golesDePenalti:   int('golesDePenalti').notNull().default(0),
  tarjetasAmarillas: int('tarjetasAmarillas').notNull().default(0),
  tarjetaRoja:      boolean('tarjetaRoja').notNull().default(false),
  resultado:        mysqlEnum('resultado', resultadoPartidoValues).notNull().default('DERROTA'),
  golesEncajados:   int('golesEncajados').notNull().default(0),
  golesAFavor:      int('golesAFavor').notNull().default(0),
  golEnPropia:      int('golEnPropia').notNull().default(0),
  diferenciaGoles:  int('diferenciaGoles').notNull().default(0),
  puntosCalculados: int('puntosCalculados').notNull().default(0),
  desglose:         json('desglose'),
}, t => ({
  jornadaJugadorUniq: uniqueIndex('ej_jornada_jugador').on(t.jornadaId, t.jugadorEquipoId),
}))

export const puntuacionJornada = mysqlTable('puntuacionJornada', {
  id:            varchar('id', { length: 36 }).primaryKey(),
  jornadaId:     varchar('jornadaId', { length: 36 }).notNull(),
  miembroLigaId: varchar('miembroLigaId', { length: 36 }).notNull(),
  puntos:        int('puntos').notNull(),
}, t => ({
  jornadaMiembroUniq: uniqueIndex('pj_jornada_miembro').on(t.jornadaId, t.miembroLigaId),
}))

// ─── RELATIONS ──────────────────────────────────────

export const usuarioRelations = relations(usuario, ({ many }) => ({
  ligasCreadas: many(liga),
  membresias:   many(miembroLiga),
  accionesAdmin: many(historialAdmin),
}))

export const ligaRelations = relations(liga, ({ one, many }) => ({
  creador:         one(usuario, { fields: [liga.creadorId], references: [usuario.id] }),
  miembros:        many(miembroLiga),
  plantillaFantasy: many(plantillaFantasy),
  ofertas:         many(ofertaMercado),
  transferencias:  many(transferencia),
}))

export const miembroLigaRelations = relations(miembroLiga, ({ one, many }) => ({
  liga:            one(liga, { fields: [miembroLiga.ligaId], references: [liga.id] }),
  usuario:         one(usuario, { fields: [miembroLiga.usuarioId], references: [usuario.id] }),
  plantillaFantasy: many(plantillaFantasy),
  titulares:       many(titularLiga),
  pujas:           many(puja),
  ofertasVenta:    many(ofertaMercado),
  compras:         many(transferencia, { relationName: 'comprador' }),
  ventas:          many(transferencia, { relationName: 'vendedor' }),
  snapshots:       many(snapshotAlineacion),
  puntuaciones:    many(puntuacionJornada),
}))

export const equipoRelations = relations(equipo, ({ many }) => ({
  jugadores: many(jugadorEquipo),
}))

export const jugadorRelations = relations(jugador, ({ many }) => ({
  historialEquipos: many(jugadorEquipo),
  plantillaFantasy: many(plantillaFantasy),
  ofertas:          many(ofertaMercado),
  transferencias:   many(transferencia),
  titularEn:        many(titularLiga),
}))

export const jugadorEquipoRelations = relations(jugadorEquipo, ({ one, many }) => ({
  jugador:      one(jugador, { fields: [jugadorEquipo.jugadorId], references: [jugador.id] }),
  equipo:       one(equipo, { fields: [jugadorEquipo.equipoId], references: [equipo.id] }),
  snapshots:    many(snapshotAlineacion),
  estadisticas: many(estadisticaJornada),
}))

export const plantillaFantasyRelations = relations(plantillaFantasy, ({ one }) => ({
  liga:        one(liga, { fields: [plantillaFantasy.ligaId], references: [liga.id] }),
  miembroLiga: one(miembroLiga, { fields: [plantillaFantasy.miembroLigaId], references: [miembroLiga.id] }),
  jugador:     one(jugador, { fields: [plantillaFantasy.jugadorId], references: [jugador.id] }),
}))

export const titularLigaRelations = relations(titularLiga, ({ one }) => ({
  miembroLiga: one(miembroLiga, { fields: [titularLiga.miembroLigaId], references: [miembroLiga.id] }),
  jugador:     one(jugador, { fields: [titularLiga.jugadorId], references: [jugador.id] }),
}))

export const ofertaMercadoRelations = relations(ofertaMercado, ({ one, many }) => ({
  liga:         one(liga, { fields: [ofertaMercado.ligaId], references: [liga.id] }),
  jugador:      one(jugador, { fields: [ofertaMercado.jugadorId], references: [jugador.id] }),
  vendedor:     one(miembroLiga, { fields: [ofertaMercado.vendedorId], references: [miembroLiga.id] }),
  pujas:        many(puja),
  transferencia: one(transferencia, { fields: [ofertaMercado.id], references: [transferencia.ofertaId] }),
}))

export const pujaRelations = relations(puja, ({ one }) => ({
  oferta:      one(ofertaMercado, { fields: [puja.ofertaMercadoId], references: [ofertaMercado.id] }),
  miembroLiga: one(miembroLiga, { fields: [puja.miembroLigaId], references: [miembroLiga.id] }),
}))

export const historialAdminRelations = relations(historialAdmin, ({ one }) => ({
  admin: one(usuario, { fields: [historialAdmin.adminId], references: [usuario.id] }),
}))

export const jornadaRelations = relations(jornada, ({ many }) => ({
  snapshots:    many(snapshotAlineacion),
  estadisticas: many(estadisticaJornada),
  puntuaciones: many(puntuacionJornada),
}))

export const snapshotAlineacionRelations = relations(snapshotAlineacion, ({ one }) => ({
  jornada:       one(jornada, { fields: [snapshotAlineacion.jornadaId], references: [jornada.id] }),
  miembroLiga:   one(miembroLiga, { fields: [snapshotAlineacion.miembroLigaId], references: [miembroLiga.id] }),
  jugadorEquipo: one(jugadorEquipo, { fields: [snapshotAlineacion.jugadorEquipoId], references: [jugadorEquipo.id] }),
}))

export const transferenciaRelations = relations(transferencia, ({ one }) => ({
  jugador:   one(jugador, { fields: [transferencia.jugadorId], references: [jugador.id] }),
  liga:      one(liga, { fields: [transferencia.ligaId], references: [liga.id] }),
  vendedor:  one(miembroLiga, { fields: [transferencia.vendedorId], references: [miembroLiga.id], relationName: 'vendedor' }),
  comprador: one(miembroLiga, { fields: [transferencia.compradorId], references: [miembroLiga.id], relationName: 'comprador' }),
  oferta:    one(ofertaMercado, { fields: [transferencia.ofertaId], references: [ofertaMercado.id] }),
}))

export const estadisticaJornadaRelations = relations(estadisticaJornada, ({ one }) => ({
  jornada:       one(jornada, { fields: [estadisticaJornada.jornadaId], references: [jornada.id] }),
  jugadorEquipo: one(jugadorEquipo, { fields: [estadisticaJornada.jugadorEquipoId], references: [jugadorEquipo.id] }),
}))

export const puntuacionJornadaRelations = relations(puntuacionJornada, ({ one }) => ({
  jornada:     one(jornada, { fields: [puntuacionJornada.jornadaId], references: [jornada.id] }),
  miembroLiga: one(miembroLiga, { fields: [puntuacionJornada.miembroLigaId], references: [miembroLiga.id] }),
}))

export const configPuntuacionRelations = relations(configPuntuacion, () => ({}))

export const aliasEquipoRelations = relations(aliasEquipo, ({ one }) => ({
  equipo: one(equipo, { fields: [aliasEquipo.equipoId], references: [equipo.id] }),
}))

export const aliasJugadorRelations = relations(aliasJugador, ({ one }) => ({
  jugador: one(jugador, { fields: [aliasJugador.jugadorId], references: [jugador.id] }),
}))

export const historialSaldoRelations = relations(historialSaldo, ({ one }) => ({
  miembroLiga: one(miembroLiga, { fields: [historialSaldo.miembroLigaId], references: [miembroLiga.id] }),
  liga:        one(liga,        { fields: [historialSaldo.ligaId],        references: [liga.id] }),
  jugador:     one(jugador,     { fields: [historialSaldo.jugadorId],     references: [jugador.id] }),
}))

export const historialValorJugadorRelations = relations(historialValorJugador, ({ one }) => ({
  jugador: one(jugador, { fields: [historialValorJugador.jugadorId], references: [jugador.id] }),
}))

export const historialClausulaRelations = relations(historialClausula, ({ one }) => ({
  jugador:     one(jugador,     { fields: [historialClausula.jugadorId],     references: [jugador.id] }),
  liga:        one(liga,        { fields: [historialClausula.ligaId],        references: [liga.id] }),
  miembroLiga: one(miembroLiga, { fields: [historialClausula.miembroLigaId], references: [miembroLiga.id] }),
}))

export const historialConfigRelations = relations(historialConfig, ({ one }) => ({
  admin: one(usuario, { fields: [historialConfig.adminId], references: [usuario.id] }),
}))
