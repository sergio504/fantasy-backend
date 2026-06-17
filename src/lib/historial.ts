import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  historialSaldo, historialClausula, historialValorJugador, historialConfig,
  ConceptoSaldo, MotivoClausula, TipoHistorialConfig,
} from '../db/schema'

type DbLike = typeof db | any

export async function registrarMovimientoSaldo(
  dbLike: DbLike,
  params: {
    miembroLigaId: string
    ligaId:        string
    concepto:      ConceptoSaldo
    importe:       number
    saldoResultante: number
    descripcion?:  string
    jugadorId?:    string
    numJornada?:   number
  },
) {
  await dbLike.insert(historialSaldo).values({
    id:              randomUUID(),
    miembroLigaId:   params.miembroLigaId,
    ligaId:          params.ligaId,
    concepto:        params.concepto,
    importe:         params.importe,
    saldoResultante: params.saldoResultante,
    descripcion:     params.descripcion,
    jugadorId:       params.jugadorId,
    numJornada:      params.numJornada,
    creadoEn:        new Date(),
  })
}

export async function registrarCambioClausula(
  dbLike: DbLike,
  params: {
    jugadorId:        string
    ligaId:           string
    miembroLigaId:    string
    clausulaAnterior: number
    clausulaNueva:    number
    motivo:           MotivoClausula
  },
) {
  await dbLike.insert(historialClausula).values({
    id:               randomUUID(),
    jugadorId:        params.jugadorId,
    ligaId:           params.ligaId,
    miembroLigaId:    params.miembroLigaId,
    clausulaAnterior: params.clausulaAnterior,
    clausulaNueva:    params.clausulaNueva,
    motivo:           params.motivo,
    creadoEn:         new Date(),
  })
}

export async function registrarCambioValor(params: {
  jugadorId:     string
  valorAnterior: number
  valorNuevo:    number
  numJornada:    number
}) {
  await db.insert(historialValorJugador).values({
    id:            randomUUID(),
    jugadorId:     params.jugadorId,
    valorAnterior: params.valorAnterior,
    valorNuevo:    params.valorNuevo,
    numJornada:    params.numJornada,
    creadoEn:      new Date(),
  })
}

export async function registrarCambioConfig(params: {
  tipo:          TipoHistorialConfig
  campo:         string
  valorAnterior: number | null
  valorNuevo:    number
  adminId:       string
}) {
  await db.insert(historialConfig).values({
    id:            randomUUID(),
    tipo:          params.tipo,
    campo:         params.campo,
    valorAnterior: params.valorAnterior ?? undefined,
    valorNuevo:    params.valorNuevo,
    adminId:       params.adminId,
    creadoEn:      new Date(),
  })
}
