import asyncio
import re
import json
import subprocess
import os
import argparse
from urllib.parse import urlparse
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup

URL = "https://www.lapreferente.com/C22283-19/tercera-federacion-grupo-4/calendario.html"

# Extraer nombre de competición del segundo segmento de la URL
_partes_url = urlparse(URL).path.strip("/").split("/")
COMPETICION = _partes_url[1]  # ej: "tercera-federacion-grupo-4"

parser = argparse.ArgumentParser(description="Extrae estadísticas de una jornada")
parser.add_argument("jornada", type=int, help="Número de jornada a extraer (ej: 1)")
args = parser.parse_args()
NUM_JORNADA = args.jornada


def extraer_equipo(tabla):
    nombre_equipo = "DESCONOCIDO"
    jugadores = []
    seccion_actual = None
    ultimo_titular_idx = None  # índice del último titular añadido, para actualizar su minuto_salida

    todos_los_tr = tabla.find_all("tr")
    print(f"  >> Total <tr>: {len(todos_los_tr)}")

    for idx, tr in enumerate(todos_los_tr):
        th = tr.find("th")
        if th:
            texto_th = th.get_text(strip=True)
            print(f"    [tr {idx}] th: '{texto_th}'")
            if re.search(r"CUERPO.TÉCNICO", texto_th, re.IGNORECASE):
                print(f"    [tr {idx}] -> CUERPO TÉCNICO — fin")
                break
            elif re.search(r"TITULARES", texto_th, re.IGNORECASE):
                seccion_actual = "titulares"
                nombre_equipo = re.sub(r"^TITULARES\s*", "", texto_th, flags=re.IGNORECASE).strip()
                print(f"    [tr {idx}] -> TITULARES. Equipo: '{nombre_equipo}'")
            elif re.search(r"SUPLENTES", texto_th, re.IGNORECASE):
                seccion_actual = "suplentes"
                print(f"    [tr {idx}] -> SUPLENTES")
            continue

        tds = tr.find_all("td")
        if not tds or seccion_actual is None:
            continue

        td_nombre = tr.find("td", id="tdJugadorAlineado")
        if not td_nombre:
            continue

        # Nombre corto y nombre completo desde los dos span dentro del <a>
        spans = td_nombre.find("a").find_all("span") if td_nombre.find("a") else []
        if len(spans) >= 2:
            nombre = spans[0].get_text(strip=True)
            nombre_completo = spans[1].get_text(strip=True)
        elif len(spans) == 1:
            nombre = spans[0].get_text(strip=True)
            nombre_completo = nombre
        else:
            nombre = td_nombre.get_text(strip=True)
            nombre_completo = nombre

        if not nombre:
            continue

        img = tr.find("img", id="imgSustitucion")

        if seccion_actual == "titulares":
            if img:
                # Sustituto que entró: calculamos su minuto de entrada
                minuto = None
                m = re.search(r"(\d+)", img.get("title", ""))
                if m:
                    minuto = int(m.group(1))

                # El titular que salió en ese minuto es el último que añadimos
                if ultimo_titular_idx is not None:
                    jugadores[ultimo_titular_idx]["minuto_salida"] = minuto
                    ultimo_titular_idx = None

                print(f"    [tr {idx}] -> ENTRA min {minuto}: '{nombre}'")
                jugadores.append({
                    "nombre": nombre,
                    "nombre_completo": nombre_completo,
                    "titular": False,
                    "convocado": True,
                    "minuto_entrada": minuto,
                    "minuto_salida": 90,
                })
            else:
                print(f"    [tr {idx}] -> TITULAR: '{nombre}'")
                jugadores.append({
                    "nombre": nombre,
                    "nombre_completo": nombre_completo,
                    "titular": True,
                    "convocado": True,
                    "minuto_entrada": 0,
                    "minuto_salida": 90,  # se actualizará si es sustituido
                })
                ultimo_titular_idx = len(jugadores) - 1

        elif seccion_actual == "suplentes":
            nombres_ya = {j["nombre_completo"] for j in jugadores}
            if nombre_completo in nombres_ya:
                print(f"    [tr {idx}] -> Ya entró al partido, ignorando: '{nombre}'")
            else:
                print(f"    [tr {idx}] -> SUPLENTE (no jugó): '{nombre}'")
                jugadores.append({
                    "nombre": nombre,
                    "nombre_completo": nombre_completo,
                    "titular": False,
                    "convocado": True,
                    "minuto_entrada": None,
                    "minuto_salida": None,
                })

    print(f"  >> Total jugadores: {len(jugadores)}")
    return nombre_equipo, jugadores


def extraer_alineaciones(html_div):
    soup = BeautifulSoup(html_div, "html.parser")
    tablas = soup.find_all("table", id=re.compile(r"^tableAlineados"))
    print(f"\n[ALINEACIONES] Tablas encontradas: {len(tablas)}")

    if not tablas:
        todas = soup.find_all("table")
        print(f"[ALINEACIONES] Todas las tablas ({len(todas)}):")
        for t in todas:
            print(f"  id='{t.get('id', '')}' class='{t.get('class', '')}'")

    equipos = []
    for i, tabla in enumerate(tablas):
        print(f"\n[ALINEACIONES] Tabla {i+1}: id='{tabla.get('id')}'")
        nombre_equipo, jugadores = extraer_equipo(tabla)
        equipos.append({"equipo": nombre_equipo, "jugadores": jugadores})

    return equipos


def extraer_goles(html_div):
    soup = BeautifulSoup(html_div, "html.parser")
    tablas = soup.find_all("table", class_="datosPartido")
    print(f"\n[GOLES] Tablas encontradas: {len(tablas)}")

    goles_equipos = []

    for i, tabla in enumerate(tablas):
        th = tabla.find("th")
        if not th:
            continue
        texto_th = th.get_text(strip=True)
        nombre_equipo = re.sub(r"^GOLEADORES\s*", "", texto_th, flags=re.IGNORECASE).strip()
        print(f"\n[GOLES] Equipo {i+1}: '{nombre_equipo}'")

        goles = []
        for tr in tabla.find_all("tr"):
            td_jugador = tr.find("td", id="tdJugadorAlineado")
            td_resultado = tr.find("td", id="tdResultadoParcial")
            if not td_jugador or not td_resultado:
                continue

            spans = td_jugador.find("a").find_all("span") if td_jugador.find("a") else []
            if len(spans) >= 2:
                nombre = spans[0].get_text(strip=True)
                nombre_completo = spans[1].get_text(strip=True)
            elif len(spans) == 1:
                nombre = spans[0].get_text(strip=True)
                nombre_completo = nombre
            else:
                nombre = td_jugador.get_text(strip=True)
                nombre_completo = nombre

            # El minuto está en el segundo <p> del td, formato 'min. 45'
            parrafos = td_resultado.find_all("p")
            minuto = None
            if len(parrafos) >= 2:
                m = re.search(r"(\d+)", parrafos[1].get_text(strip=True))
                if m:
                    minuto = int(m.group(1))

            # Detectar tipo de gol por el título de la imagen en tdJugadorAlineado
            imgs = td_jugador.find_all("img")
            es_penalty = any(re.search(r"penalti", i.get("title", ""), re.IGNORECASE) for i in imgs)
            es_propia = any(re.search(r"propia meta", i.get("title", ""), re.IGNORECASE) for i in imgs)

            tipo = " [PENALTY]" if es_penalty else (" [PROPIA META]" if es_propia else "")
            print(f"  Gol: '{nombre}' min {minuto}{tipo}")
            goles.append({
                "jugador": nombre,
                "jugador_completo": nombre_completo,
                "minuto": minuto,
                "es_penalty": es_penalty,
                "es_propia_meta": es_propia,
            })

        goles_equipos.append({"equipo": nombre_equipo, "goles": goles})

    return goles_equipos


def extraer_tarjetas(html_div, equipos):
    """
    Lee divTarjetasPartido y añade tarjetas a los jugadores que ya están en equipos.
    Ignora tarjetas de cuerpo técnico (su nombre no estará en la lista de jugadores).
    """
    soup = BeautifulSoup(html_div, "html.parser")
    tablas = [t for t in soup.find_all("table", class_="datosPartido") if t.get("id") != "tableArbitroPartido"]
    print(f"\n[TARJETAS] Tablas encontradas: {len(tablas)}")

    # Índice rápido: nombre_completo -> jugador, por equipo
    indices = []
    for equipo_data in equipos:
        idx = {j["nombre_completo"]: j for j in equipo_data["jugadores"]}
        indices.append(idx)

    for i, tabla in enumerate(tablas):
        th = tabla.find("th")
        if not th:
            continue
        texto_th = th.get_text(strip=True)
        nombre_equipo = re.sub(r"^TARJETAS\s*", "", texto_th, flags=re.IGNORECASE).strip()
        print(f"\n[TARJETAS] Equipo {i+1}: '{nombre_equipo}'")

        indice_equipo = indices[i] if i < len(indices) else {}

        for tr in tabla.find_all("tr"):
            td_jugador = tr.find("td", id=re.compile(r"jugadorAlineado", re.IGNORECASE))
            td_tarjeta = tr.find("td", id="tdDatosTarjeta")
            if not td_jugador or not td_tarjeta:
                continue

            spans = td_jugador.find("a").find_all("span") if td_jugador.find("a") else []
            if len(spans) >= 2:
                nombre_completo = spans[1].get_text(strip=True)
                nombre = spans[0].get_text(strip=True)
            elif len(spans) == 1:
                nombre = spans[0].get_text(strip=True)
                nombre_completo = nombre
            else:
                nombre = td_jugador.get_text(strip=True)
                nombre_completo = nombre

            # Contar amarillas y rojas desde todas las imágenes del td
            imgs = td_tarjeta.find_all("img")
            num_amarillas = sum(1 for i in imgs if "yellow" in i.get("src", "").lower())
            num_rojas = sum(1 for i in imgs if "red" in i.get("src", "").lower())

            # Regla: si hay 3 imágenes (2 amarillas + 1 roja), la roja es consecuencia
            # de la doble amarilla — no se cuenta como roja directa.
            # Si hay 2 (1 amarilla + 1 roja), ambas cuentan.
            tarjetas_evento = []
            if num_amarillas == 2 and num_rojas == 1:
                tarjetas_evento = ["yellow", "yellow"]
            else:
                tarjetas_evento = ["yellow"] * num_amarillas + ["red"] * num_rojas

            print(f"  Tarjetas {tarjetas_evento}: '{nombre}'", end="")

            # Solo añadir si el jugador está en la plantilla (no cuerpo técnico)
            jugador = indice_equipo.get(nombre_completo)
            if jugador:
                jugador.setdefault("tarjetas", []).extend(tarjetas_evento)
                print(f" -> añadidas")
            else:
                print(f" -> no es jugador, ignorado")


def calcular_goles_jugadores(equipos, goles_equipos):
    """
    Para cada jugador añade goles_a_favor y goles_en_contra:
    solo cuentan los goles marcados mientras estaba en el campo.
    Los suplentes que no jugaron reciben None.
    El resultado (VICTORIA/EMPATE/DERROTA) es siempre el marcador global del partido.
    """
    for i, equipo_data in enumerate(equipos):
        goles_favor = goles_equipos[i]["goles"] if i < len(goles_equipos) else []
        goles_contra = goles_equipos[1 - i]["goles"] if (1 - i) < len(goles_equipos) else []

        total_favor = len(goles_favor)
        total_contra = len(goles_contra)
        if total_favor > total_contra:
            resultado_global = "VICTORIA"
        elif total_favor < total_contra:
            resultado_global = "DERROTA"
        else:
            resultado_global = "EMPATE"

        for jugador in equipo_data["jugadores"]:
            jugador["resultado"] = resultado_global

            # Suplente que no pisó el campo
            if jugador["minuto_entrada"] is None:
                jugador["goles_a_favor"] = None
                jugador["goles_en_contra"] = None
                continue

            entrada = jugador["minuto_entrada"]
            salida = jugador["minuto_salida"] or 90

            jugador["goles_a_favor"] = sum(
                1 for g in goles_favor
                if g["minuto"] is not None and entrada <= g["minuto"] <= salida
            )
            jugador["goles_en_contra"] = sum(
                1 for g in goles_contra
                if g["minuto"] is not None and entrada <= g["minuto"] <= salida
            )


async def procesar_partido(page, url, idx):
    print(f"\n{'='*60}")
    print(f"[Partido {idx}] Cargando {url}")
    await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    print(f"[Partido {idx}] Cargado: {await page.title()}")

    # Alineaciones
    alin_loc = page.locator("#divAlineacionesPartido")
    if await alin_loc.count() == 0:
        print(f"[Partido {idx}] Sin #divAlineacionesPartido — saltando")
        return None
    equipos = extraer_alineaciones(await alin_loc.first.inner_html())

    # Goles
    goles_equipos = []
    goles_loc = page.locator("#divGoleadoresPartido")
    if await goles_loc.count() > 0:
        goles_equipos = extraer_goles(await goles_loc.first.inner_html())

    if goles_equipos and len(goles_equipos) == len(equipos):
        calcular_goles_jugadores(equipos, goles_equipos)

    # Tarjetas
    tarj_loc = page.locator("#divTarjetasPartido")
    if await tarj_loc.count() > 0:
        extraer_tarjetas(await tarj_loc.first.inner_html(), equipos)

    # Resumen por consola
    for equipo in equipos:
        print(f"\n  === {equipo['equipo']} ===")
        for j in equipo["jugadores"]:
            if j["minuto_entrada"] is None:
                estado = "SUP"
            elif j["titular"]:
                estado = f"TIT->sal.{j['minuto_salida']}'"
            else:
                estado = f"ENT {j['minuto_entrada']}'"
            gf = j.get("goles_a_favor")
            gc = j.get("goles_en_contra")
            tarj = j.get("tarjetas", [])
            extra = f"  [GF:{gf} GC:{gc}]" if gf is not None else ""
            extra += f"  {tarj}" if tarj else ""
            print(f"    [{estado}] {j['nombre']:25s}{extra}")

    return {
        "url": url,
        "equipos": equipos,
        "goles": [{"equipo": g["equipo"], "goles": g["goles"]} for g in goles_equipos],
    }


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        print(f"[1] Conectando a {URL} ...")
        await page.goto(URL, wait_until="domcontentloaded", timeout=60_000)
        print(f"[1] Cargada.")

        flex_divs = page.locator("#calendarContainer div[style*='display:flex']")
        count = await flex_divs.count()
        print(f"[2] Divs flex en calendario: {count}")

        # Recoger todas las URLs de la jornada solicitada
        urls_jornada = []
        nombre_jornada = None

        for i in range(count):
            hijos = flex_divs.nth(i).locator("> div")
            num_hijos = await hijos.count()
            for j in range(num_hijos):
                th = hijos.nth(j).locator("table tr:first-child th")
                if await th.count() == 0:
                    continue

                texto_th = (await th.first.inner_text()).strip()
                texto_th = texto_th.replace("schedule", "").replace("get_app", "").strip()

                # Comprobar si este bloque corresponde a la jornada pedida
                m_num = re.search(r"JORNADA\s+(\d+)", texto_th, re.IGNORECASE)
                if not m_num or int(m_num.group(1)) != NUM_JORNADA:
                    continue

                nombre_jornada = texto_th
                filas = hijos.nth(j).locator("tr#filaPartido")
                num_filas = await filas.count()
                for k in range(num_filas):
                    onclick = await filas.nth(k).get_attribute("onclick")
                    m = re.search(r"window\.location='([^']+)'", onclick or "")
                    if m:
                        urls_jornada.append(f"https://www.lapreferente.com/{m.group(1)}")

        print(f"[2] Jornada: '{nombre_jornada}' — {len(urls_jornada)} partidos encontrados")
        for u in urls_jornada:
            print(f"    {u}")

        if not urls_jornada:
            print(f"[!] No se encontraron partidos para la jornada {NUM_JORNADA}.")
            await browser.close()
            return

        # Procesar cada partido
        partidos = []
        for idx, url in enumerate(urls_jornada, 1):
            resultado = await procesar_partido(page, url, idx)
            if resultado:
                partidos.append(resultado)

        # Guardar JSON
        salida = {
            "jornada": nombre_jornada,
            "partidos": partidos,
        }
        json_filename = f"jornada_{NUM_JORNADA}.json"
        json_dir = os.path.join(os.path.dirname(__file__), "Estadisticas", COMPETICION)
        os.makedirs(json_dir, exist_ok=True)
        json_path = os.path.join(json_dir, json_filename)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(salida, f, ensure_ascii=False, indent=2)
        print(f"\n[FIN] {len(partidos)} partidos guardados en Estadisticas/{COMPETICION}/{json_filename}")

        await browser.close()

    # Llamar al importador TypeScript una vez cerrado el browser
    print(f"\n[IMPORT] Lanzando importar-jornada.ts ...")
    backend_dir = os.path.dirname(__file__)
    resultado = subprocess.run(
        f"npx tsx prisma/importar-jornada.ts {NUM_JORNADA}",
        cwd=backend_dir,
        text=True,
        shell=True,
    )
    if resultado.returncode == 0:
        print("[IMPORT] Importación completada correctamente.")
    else:
        print(f"[IMPORT] Error en la importación (código {resultado.returncode}).")


asyncio.run(main())
