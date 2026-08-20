-- Borra jornadas, estadísticas, mercado, plantillas fantasy e históricos.
-- Mantiene: usuario, liga, miembroLiga (reseteado), equipo, jugador,
-- jugadorEquipo, divisiones, aliasEquipo, aliasJugador y config*.

START TRANSACTION;

-- Jornadas y todo lo que cuelga de ellas
DELETE FROM `puntuacionJornada`;
DELETE FROM `estadisticaJornada`;
DELETE FROM `estadisticaJornadaSinRegistrar`;
DELETE FROM `snapshotAlineacion`;
DELETE FROM `penalizacionJornada`;
DELETE FROM `jornada`;

-- Mercado y fichajes
DELETE FROM `puja`;
DELETE FROM `transferencia`;
DELETE FROM `ofertaMercado`;
DELETE FROM `clausulazoPendiente`;

-- Plantillas fantasy y alineaciones titulares
DELETE FROM `titularLiga`;
DELETE FROM `plantillaFantasy`;

-- Históricos
DELETE FROM `historialAdmin`;
DELETE FROM `historialSaldo`;
DELETE FROM `historialValorJugador`;
DELETE FROM `historialClausula`;
DELETE FROM `historialConfig`;

-- Reset de presupuesto, puntuación y capitán por miembro de liga
UPDATE `miembroLiga` ml
JOIN `liga` l ON l.id = ml.ligaId
SET ml.presupuestoRestante = l.presupuestoInicial,
    ml.puntuacion = 0,
    ml.capitanId = NULL;

COMMIT;
