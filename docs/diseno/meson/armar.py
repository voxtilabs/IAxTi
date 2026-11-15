"""Arma las páginas estáticas del prototipo Mesón (Bandeja, Contactos, Oportunidades)."""
import pathlib

OUT = pathlib.Path(__file__).parent

ISOTIPO = ("M 9.06,54.01 L 155.5,180.45 A 34,34 0 0,0 199.94,128.99 L 53.5,2.55 A 34,34 0 0,0 9.06,54.01 "
           "M 155.5,2.55 L 9.06,128.99 A 34,34 0 0,0 53.5,180.45 L 199.94,54.01 A 34,34 0 0,0 155.5,2.55")


def jelly(i: str) -> str:
    """El isotipo jelly oficial (se queda igual, por decisión de Lino)."""
    return f'''<svg viewBox="-24 -20 264 242" fill="none" aria-hidden="true">
<defs><path id="{i}s" d="{ISOTIPO}"/>
<linearGradient id="{i}m" x1="18" y1="0" x2="164" y2="198" gradientUnits="userSpaceOnUse"><stop stop-color="#C4FAFF"/><stop offset=".16" stop-color="#24D0E7"/><stop offset=".43" stop-color="#3D5AFE"/><stop offset=".78" stop-color="#1C60E8"/><stop offset="1" stop-color="#1549A3"/></linearGradient>
<radialGradient id="{i}l"><stop stop-color="#F2FEFF" stop-opacity=".96"/><stop offset=".28" stop-color="#C4FAFF" stop-opacity=".85"/><stop offset=".62" stop-color="#24D0E7" stop-opacity=".55"/><stop offset="1" stop-color="#24D0E7" stop-opacity="0"/></radialGradient>
<clipPath id="{i}c"><use href="#{i}s"/></clipPath></defs>
<use href="#{i}s" transform="translate(3 7)" fill="#1549A3" opacity=".88"/><use href="#{i}s" fill="url(#{i}m)"/>
<g clip-path="url(#{i}c)"><ellipse cx="33" cy="28" rx="43" ry="34" fill="url(#{i}l)"/><ellipse cx="172" cy="28" rx="39" ry="32" fill="url(#{i}l)"/><ellipse cx="178" cy="145" rx="42" ry="36" fill="url(#{i}l)"/><ellipse cx="43" cy="144" rx="32" ry="35" fill="url(#{i}l)" opacity=".75"/></g>
</svg>'''


NAV = [
    ("Trabajo", [("bandeja", "inbox", "Bandeja", "12"), ("oportunidades", "target", "Oportunidades", ""),
                 ("agenda", "calendar-days", "Agenda", "3"), ("pendientes", "list-todo", "Pendientes", "5")]),
    ("Clientes", [("contactos", "users", "Contactos", ""), ("empresas", "building-2", "Empresas", "")]),
    ("Asistente", [("asistente", "bot", "Tu asistente", "")]),
    ("Resultados", [("reportes", "chart-no-axes-column", "Reportes", "")]),
]


def barra(actual: str) -> str:
    grupos = []
    for titulo, items in NAV:
        filas = "".join(
            f'<a href="{k}.html"{" aria-current=\"page\"" if k == actual else ""}><i data-lucide="{ic}"></i>{t}'
            f'{f"<span class=\"cuenta mono\">{n}</span>" if n else ""}</a>'
            for k, ic, t, n in items)
        grupos.append(f"<h4>{titulo}</h4>{filas}")
    return f'''<aside class="barra" aria-label="Navegación">
  <a class="marca" href="bandeja.html">{jelly("jb")}<b>IAxTi</b></a>
  <button class="negocio" type="button"><span>Zapatería Doña Inés</span><i data-lucide="chevrons-up-down"></i></button>
  <a class="buscar" href="#"><i data-lucide="search"></i>Buscar<span class="tecla">Ctrl K</span></a>
  <nav class="nav">{"".join(grupos)}</nav>
  <div class="pie nav">
    <a href="#"><i data-lucide="settings"></i>Ajustes</a>
    <div class="persona"><span class="ini chica">IR</span><div>Inés Riquelme<small>Dueña</small></div></div>
  </div>
</aside>'''


def pagina(nombre: str, titulo: str, cuerpo: str) -> str:
    return f'''<!doctype html>
<html lang="es-CL" data-mode="dia">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{titulo} · IAxTi</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="meson.css">
<script>try{{var m=new URLSearchParams(location.search).get('modo');if(m)document.documentElement.dataset.mode=m;}}catch(e){{}}</script>
</head>
<body>
<div class="app">
<header class="movil-barra"><a class="marca" href="bandeja.html">{jelly("jm")}<b>IAxTi</b></a><button class="btn fantasma" aria-label="Abrir el menú"><i data-lucide="menu"></i></button></header>
{barra(nombre)}
<main class="principal">
{cuerpo}
</main>
</div>
<script src="https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js"></script>
<script>lucide.createIcons();var c=document.querySelector(".mensajes");if(c)c.scrollTop=c.scrollHeight;</script>
</body>
</html>
'''


# ── Bandeja ──────────────────────────────────────────────
CONVS = [
    ("MS", "Marta Soto", "14:06", "Perfecto, el viernes paso a buscarlas", "bot", "Asistente", ("", "21 h 54 min"), True, True),
    ("JP", "Juan Pérez", "13:41", "¿Hacen despacho a Temuco?", "user", "Inés", ("aviso", "1 h 12 min"), True, False),
    ("FN", "Ferretería Ñuñoa", "12:20", "Te envié la cotización por 24 pares", "user", "Inés", ("", "20 h 08 min"), False, False),
    ("CR", "Carla Ríos", "11:02", "Quería cambiar la talla de los botines", "bot", "Asistente", ("", "18 h 50 min"), False, False),
    ("PL", "Pedro Lagos", "ayer", "Gracias, quedo atento", "user", "Inés", ("cerrada", "cerrada"), False, False),
    ("VA", "Valentina Acuña", "ayer", "¿Tienen las Pampa en café?", "bot", "Asistente", ("cerrada", "cerrada"), False, False),
    ("RM", "Rodrigo Muñoz", "mar", "Listo, transferí", "user", "Inés", ("cerrada", "cerrada"), False, False),
]


def conv(c):
    ini, nom, hora, prev, ic, quien, (vk, vt), sin_leer, actual = c
    ven = f'<span class="ventana {vk}"><i data-lucide="clock-3"></i>{vt}</span>' if vk != "cerrada" else '<span class="ventana cerrada">ventana cerrada</span>'
    punto = '<span class="sin-leer" aria-label="Sin leer"></span>' if sin_leer and not actual else ""
    return f'''<div class="conv"{' aria-current="true"' if actual else ''}><span class="ini">{ini}</span><div>
<div class="l1"><b>{nom}</b>{punto}<span class="mono">{hora}</span></div>
<p class="prev">{prev}</p>
<div class="l3"><span class="quien"><i data-lucide="{ic}"></i>{quien}</span>{ven}</div></div></div>'''


BANDEJA = f'''<div class="bandeja">
<section class="lista" aria-label="Conversaciones">
  <div class="lista-cabeza">
    <div class="fila"><h1>Bandeja</h1><button class="btn fantasma" aria-label="Filtrar"><i data-lucide="list-filter"></i></button></div>
    <div class="segmento" role="group" aria-label="Qué mostrar"><button aria-pressed="true">Todas <span class="mono">12</span></button><button aria-pressed="false">Mías <span class="mono">4</span></button><button aria-pressed="false">Sin responder <span class="mono">3</span></button></div>
    <div class="campo"><i data-lucide="search"></i>Buscar en mensajes y notas</div>
  </div>
  <div class="convs">{"".join(conv(c) for c in CONVS)}</div>
</section>

<section class="chat" aria-label="Conversación con Marta Soto">
  <div class="chat-cabeza">
    <span class="ini">MS</span>
    <div><h2>Marta Soto</h2><span class="mono">+56 9 8123 4567</span></div>
    <div class="acciones">
      <span class="ventana pastilla" title="Puedes responder libre hasta mañana 14:06"><i data-lucide="clock-3"></i>21 h 54 min</span>
      <button class="btn"><i data-lucide="hand"></i>Tomar la conversación</button>
      <button class="btn fantasma" aria-label="Más acciones"><i data-lucide="ellipsis"></i></button>
    </div>
  </div>
  <div class="mensajes">
    <span class="dia mono">Hoy, 13 de noviembre</span>
    <div class="msg entra"><div class="burbuja"><div class="foto" role="img" aria-label="Foto de un botín negro"></div>Hola! ¿tienen este botín en talla 40 en negro?</div><span class="meta">13:58</span></div>
    <div class="msg sale otro-lado"><div class="burbuja">Hola Marta. Sí, nos quedan dos pares del Pampa negro en 40. Está a $ 48.900 y lo puedes probar en la tienda de Ñuñoa.</div><span class="meta"><i data-lucide="bot"></i>Asistente · 14:02</span></div>
    <div class="msg entra otro-lado"><div class="burbuja">Buenísimo. ¿Me guardan uno para el viernes en la mañana?</div><span class="meta">14:04</span></div>
    <div class="msg sale otro-lado"><div class="burbuja">Listo, te lo dejo reservado el viernes 15 a las 10:30. Si prefieres asegurarlo, aquí puedes pagarlo ahora.</div><span class="meta"><i data-lucide="bot"></i>Asistente · 14:05</span></div>
    <span class="evento"><i data-lucide="calendar-check-2"></i>El asistente agendó la visita · vie 15 nov, 10:30</span>
    <div class="msg entra"><div class="burbuja">Perfecto, el viernes paso a buscarlas</div><span class="meta">14:06</span></div>
  </div>
  <div class="redactor">
    <div class="sugerencia"><i data-lucide="bot"></i><span>Sugerencia: «Te esperamos, Marta. Cualquier cambio me avisas por aquí»</span><button class="btn">Usar</button></div>
    <div class="caja"><span class="texto">Escribe tu respuesta</span><button class="btn fantasma" aria-label="Adjuntar"><i data-lucide="paperclip"></i></button><button class="btn principal-btn">Enviar</button></div>
  </div>
</section>

<aside class="ficha" aria-label="Ficha del cliente">
  <div class="quien-es"><span class="ini">MS</span><div><h3>Marta Soto</h3><span style="color:var(--apagado);font-size:13px">Cliente desde marzo de 2025</span></div></div>
  <dl class="datos">
    <dt>Teléfono</dt><dd class="mono">+56 9 8123 4567</dd>
    <dt>RUT</dt><dd class="mono">15.482.396-K</dd>
    <dt>Comuna</dt><dd>Ñuñoa</dd>
    <dt>Atiende</dt><dd>Asistente · Inés supervisa</dd>
  </dl>
  <div class="bloque">
    <h5>Oportunidad<span class="mas">Propuesta</span></h5>
    <div class="opor">
      <span>Botín Pampa negro, talla 40</span>
      <span class="monto">$ 48.900</span>
      <div class="etapas" aria-label="Etapa 3 de 4"><i class="hecha"></i><i class="hecha"></i><i class="ahora"></i><i></i></div>
      <div class="pie-opor"><span>Nuevo → Ganado</span><span class="mono">hace 8 min</span></div>
    </div>
  </div>
  <div class="bloque">
    <h5>Lo que hizo el asistente<span class="mas mono">hoy</span></h5>
    <div class="boleta">
      <div class="tit"><span>Asistente IAxTi</span><span>13-11-2026</span></div>
      <div class="linea"><span>14:02</span><span><b>Respondió</b><em>stock Pampa negro 40: 2 pares</em></span></div>
      <div class="linea"><span>14:05</span><span><b>Agendó</b><em>vie 15 nov, 10:30 · Ñuñoa</em></span></div>
      <div class="linea"><span>14:05</span><span><b>Envió link</b><em>pago por $ 48.900</em></span></div>
      <div class="corte"></div>
      <div class="total"><span>Por cobrar</span><span>$ 48.900</span></div>
      <span class="timbre">Sin pago aún</span>
    </div>
  </div>
  <div class="bloque">
    <h5>Notas del equipo</h5>
    <div class="nota"><b>Inés</b> · Clienta frecuente, compra para la hija. Ofrecerle el cuidado de cuero.</div>
  </div>
</aside>
</div>'''

# ── Contactos ────────────────────────────────────────────
FILAS = [
    ("Marta Soto", "+56 9 8123 4567", "Perfecto, el viernes paso a buscarlas", "14:06", "propuesta", "Propuesta", "Asistente", ("", "21 h 54 min"), "Sí · 02-11", False),
    ("Juan Pérez", "+56 9 7745 2210", "¿Hacen despacho a Temuco?", "13:41", "", "Nuevo", "Inés", ("aviso", "1 h 12 min"), "Sí · 13-11", True),
    ("Ferretería Ñuñoa", "+56 2 2274 8810", "Te envié la cotización por 24 pares", "12:20", "", "Cotizado", "Inés", ("", "20 h 08 min"), "Sí · 28-10", True),
    ("Carla Ríos", "+56 9 6631 0098", "Quería cambiar la talla de los botines", "11:02", "ganado", "Ganado", "Asistente", ("", "18 h 50 min"), "Sí · 30-09", False),
    ("Pedro Lagos", "+56 9 5512 7783", "Gracias, quedo atento", "ayer", "", "Cotizado", "Inés", ("cerrada", ""), "Sí · 11-11", False),
    ("Valentina Acuña", "+56 9 9014 3321", "¿Tienen las Pampa en café?", "ayer", "", "Nuevo", "Asistente", ("cerrada", ""), "Sí · 12-11", False),
    ("Rodrigo Muñoz", "+56 9 8870 1145", "Listo, transferí", "mar", "ganado", "Ganado", "Inés", ("cerrada", ""), "Sí · 04-11", False),
    ("Camila Fuentes", "+56 9 7302 6654", "—", "—", "", "Sin oportunidad", "—", ("cerrada", ""), "No · importado", False),
    ("Tomás Herrera", "+56 9 6128 9930", "¿A qué hora abren el sábado?", "lun", "", "Nuevo", "Asistente", ("cerrada", ""), "Sí · 10-11", False),
    ("Javiera Molina", "+56 9 5547 0012", "Me llegaron, gracias!", "08-11", "ganado", "Ganado", "Inés", ("cerrada", ""), "Sí · 01-11", False),
]


def fila(f):
    nom, tel, ult, cuando, ek, et, quien, (vk, vt), perm, sel = f
    ven = '<span class="ventana cerrada">cerrada</span>' if vk == "cerrada" else f'<span class="ventana {vk}"><i data-lucide="clock-3"></i>{vt}</span>'
    return f'''<tr{' class="elegida"' if sel else ''}><td><span class="chk{' si' if sel else ''}"></span></td>
<td><a class="nombre" href="#">{nom}</a><span class="debajo mono">{tel}</span></td>
<td><span>{ult}</span><span class="debajo mono">{cuando}</span></td>
<td><span class="etapa {ek}">{et}</span></td><td>{quien}</td><td>{ven}</td>
<td class="permiso{' no' if perm.startswith('No') else ''} mono">{perm}</td></tr>'''


CONTACTOS = f'''<div class="cabeza"><h1>Contactos</h1><span class="sub mono">1.248</span>
<div class="acciones"><button class="btn fantasma"><i data-lucide="download"></i>Exportar</button><button class="btn"><i data-lucide="upload"></i>Importar</button><button class="btn principal-btn"><i data-lucide="plus"></i>Nuevo contacto</button></div></div>
<div class="herram"><div class="campo"><i data-lucide="search"></i>Buscar por nombre, teléfono o RUT</div>
<div class="segmento" role="group" aria-label="Filtro"><button aria-pressed="true">Todos</button><button aria-pressed="false">Ventana abierta <span class="mono">38</span></button><button aria-pressed="false">Sin dueño <span class="mono">9</span></button><button aria-pressed="false">Sin permiso <span class="mono">212</span></button></div>
<button class="btn fantasma" style="margin-left:auto"><i data-lucide="columns-3"></i>Columnas</button></div>
<div class="seleccion"><span>2 contactos elegidos</span><div class="derecha"><button class="btn"><i data-lucide="user-round-check"></i>Asignar</button><button class="btn"><i data-lucide="tag"></i>Etiquetar</button><button class="btn"><i data-lucide="send"></i>Enviar plantilla</button></div></div>
<div class="tabla-marco"><table>
<thead><tr><th style="width:44px"><span class="chk"></span></th><th>Contacto</th><th>Último mensaje</th><th>Etapa</th><th>Atiende</th><th>Ventana 24 h</th><th>Permiso para escribirle</th></tr></thead>
<tbody>{"".join(fila(f) for f in FILAS)}</tbody></table></div>'''

# ── Oportunidades ────────────────────────────────────────
COLS = [
    ("Nuevo", 9, "$ 412.300", "", [
        ("Valentina Acuña", "$ 52.900", "Pampa café, talla 37", "hace 1 día", "AS"),
        ("Tomás Herrera", "$ 39.900", "Zapatilla Andes, talla 42", "hace 3 días", "AS"),
        ("Juan Pérez", "$ 96.800", "2 pares, despacho a Temuco", "hace 40 min", "IR")]),
    ("Cotizado", 6, "$ 1.186.400", "", [
        ("Ferretería Ñuñoa", "$ 878.400", "24 pares de seguridad", "hace 2 h", "IR"),
        ("Pedro Lagos", "$ 89.800", "Botín Pampa, 2 pares", "hace 1 día", "IR")]),
    ("Propuesta", 4, "$ 585.900", "ac", [
        ("Marta Soto", "$ 48.900", "Pampa negro, talla 40", "hace 8 min", "AS"),
        ("Colegio Alemán", "$ 412.000", "Uniforme escolar, 20 pares", "vence mañana", "IR")]),
    ("Ganado en noviembre", 17, "$ 1.036.400", "ganado", [
        ("Carla Ríos", "$ 44.900", "Botín Pampa, talla 38", "hoy", "AS"),
        ("Rodrigo Muñoz", "$ 129.700", "3 pares", "mar 11", "IR"),
        ("Javiera Molina", "$ 52.900", "Pampa café, talla 36", "sáb 8", "IR")]),
]


def carta(c, ganada):
    nom, monto, que, cuando, ini = c
    aviso = ' style="color:var(--aviso)"' if cuando.startswith("vence") else ""
    return f'''<div class="carta{' ganada' if ganada else ''}"><div class="l1"><b>{nom}</b><span class="num">{monto}</span></div>
<span class="que">{que}</span><div class="l3"><span class="mono"{aviso}>{cuando}</span><span class="ini chica" title="{'Asistente' if ini == 'AS' else 'Inés Riquelme'}">{'<i data-lucide="bot" style="width:13px;height:13px"></i>' if ini == 'AS' else ini}</span></div></div>'''


TABLERO = "".join(
    f'''<section class="col {k}"><div class="col-cab"><b>{t}</b><span class="mono">{n}</span><span class="num">{tot}</span></div>
{"".join(carta(c, k == "ganado") for c in cs)}</section>''' for t, n, tot, k, cs in COLS)

OPORTUNIDADES = f'''<div class="cabeza"><h1>Oportunidades</h1><span class="sub">Noviembre 2026</span>
<div class="acciones"><div class="segmento" role="group" aria-label="Vista"><button aria-pressed="true"><i data-lucide="columns-3"></i>Tablero</button><button aria-pressed="false"><i data-lucide="list"></i>Lista</button></div><button class="btn principal-btn"><i data-lucide="plus"></i>Nueva oportunidad</button></div></div>
<div class="cifras">
  <div class="cifra"><span class="et">En juego, sin contar lo ganado</span><div class="valor">$ 2.184.600</div>
    <div class="embudo"><div class="barra-emb" aria-hidden="true"><i style="flex:412"></i><i class="n2" style="flex:1186"></i><i class="ac" style="flex:586"></i></div>
    <div class="ley"><span style="--c:var(--filete-fuerte)">Nuevo <b class="mono">$ 412.300</b></span><span style="--c:color-mix(in srgb,var(--texto) 30%,transparent)">Cotizado <b class="mono">$ 1.186.400</b></span><span style="--c:var(--acento)">Propuesta <b class="mono">$ 585.900</b></span></div></div></div>
  <div class="cifra"><span class="et">Ganado en noviembre</span><div class="valor">$ 1.036.400</div><span class="cambio"><b>+18 %</b> vs octubre a la misma fecha</span></div>
  <div class="cifra"><span class="et">Cerró el asistente solo</span><div class="valor">7 de 17</div><span class="cambio">$ 348.200 sin que nadie respondiera</span></div>
</div>
<div class="tablero">{TABLERO}</div>'''

for nombre, titulo, cuerpo in [("bandeja", "Bandeja", BANDEJA), ("contactos", "Contactos", CONTACTOS),
                               ("oportunidades", "Oportunidades", OPORTUNIDADES)]:
    (OUT / f"{nombre}.html").write_text(pagina(nombre, titulo, cuerpo))
print("ok", sorted(p.name for p in OUT.iterdir()))
