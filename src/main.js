import { diffLines, diffWordsWithSpace } from 'diff'
import './style.css'

const $ = (sel) => document.querySelector(sel)
const CONTEXT = 3 // líneas sin cambios alrededor de cada cambio

let state = { sessions: [], files: [] }
let active = null // id de la tab (carpeta + branch) que se está viendo
let selected = null
const selectedBySession = new Map() // recuerda el archivo abierto en cada tab
const recent = new Set() // archivos tocados hace poco (para resaltarlos)
const activeSession = () => state.sessions.find((s) => s.id === active)
let view = 'file' // 'file': diff del archivo elegido · 'search': resultados de la búsqueda de símbolos
let symbolQuery = '' // último símbolo buscado
let focusLine = null // { side: 'l' | 'r', n } línea a la que saltar al abrir un resultado

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

async function api(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error)
  return data
}

// ---------- Árbol de carpetas ----------

function buildTree(files) {
  const root = { dirs: {}, files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    for (const dir of parts.slice(0, -1)) node = node.dirs[dir] ??= { dirs: {}, files: [] }
    node.files.push({ ...f, name: parts.at(-1) })
  }
  return root
}

function renderNode(node) {
  let html = ''
  for (const [name, child] of Object.entries(node.dirs).sort(([a], [b]) => a.localeCompare(b))) {
    html += `<details open><summary>📁 ${esc(name)}</summary><div class="children">${renderNode(child)}</div></details>`
  }
  for (const f of node.files) {
    const cls = [f.status, f.path === selected && 'selected', recent.has(f.path) && 'flash'].filter(Boolean).join(' ')
    html += `<div class="file ${cls}" data-path="${esc(f.path)}">${esc(f.name)}</div>`
  }
  return html
}

const countsHtml = (c) => `<b class="added">+${c.added}</b> <b class="modified">~${c.modified}</b> <b class="deleted">−${c.deleted}</b>`

function renderTree() {
  const session = activeSession()
  const onlyChanges = $('#only-changes').checked
  const files = onlyChanges ? state.files.filter((f) => f.status !== 'unchanged') : state.files
  $('#counts').innerHTML = session ? countsHtml(session.counts) : ''
  $('#frozen-note').hidden = !session || session.live
  $('#tree').innerHTML = files.length
    ? renderNode(buildTree(files))
    : `<div class="muted">${session ? (onlyChanges ? 'Sin cambios todavía…' : 'Carpeta vacía') : ''}</div>`
}

// ---------- Tabs (carpeta + branch) ----------

function renderTabs() {
  $('#tabs').hidden = !state.sessions.length && !state.suggestions.length
  const ghosts = state.suggestions
    .map((w) => `<div class="tab ghost" data-add="${esc(w.path)}" title="Worktree sin abrir: ${esc(w.path)}\nClick para observarlo">
        <span class="tab-branch">+ ⎇ ${esc(w.branch)}</span>
        <span class="tab-folder">${esc(w.name)}</span>
      </div>`)
    .join('')
  $('#tabs').innerHTML = state.sessions
    .map((s, i) => {
      const title = `${s.root}${s.branch ? ` — ${s.branch}` : ''}\n${s.live ? 'En vivo' : 'Branch no activa (congelada)'} · Alt+${i + 1}`
      return `<div class="tab ${s.id === active ? 'active' : ''} ${s.live ? 'live' : 'frozen'}" data-id="${s.id}" title="${esc(title)}">
        <span class="dot"></span>
        <span class="tab-branch">${esc(s.branch ? `⎇ ${s.branch}` : s.name)}</span>
        ${s.branch ? `<span class="tab-folder">${esc(s.name)}</span>` : ''}
        ${s.base ? `<span class="tab-base">vs ${esc(s.base)}</span>` : ''}
        <span class="tab-counts">${countsHtml(s.counts)}</span>
        <button class="close" data-close="${s.id}" title="Cerrar tab">×</button>
      </div>`
    })
    .join('') + ghosts
}

function selectTab(id) {
  if (active !== null) selectedBySession.set(active, selected)
  active = id
  selected = selectedBySession.get(id) ?? null
  $('#viewer').scrollTop = 0
  if (!selected) $('#viewer').innerHTML = '<div class="empty">Elegí un archivo del árbol o editá uno para verlo acá.</div>'
  if (branchesFor !== id) branchList = localBranches = remoteBranches = []
  return refresh().then(() => { renderViewer(); loadBranches() })
}

// ---------- Diff lado a lado ----------

function buildRows(oldText, newText) {
  const rows = []
  let ln = 1, rn = 1
  const parts = diffLines(oldText, newText)
  const lines = (v) => v.replace(/\n$/, '').split('\n')

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p.added && !p.removed) {
      for (const t of lines(p.value)) rows.push({ type: 'same', l: { n: ln++, t }, r: { n: rn++, t } })
    } else if (p.removed) {
      const del = lines(p.value)
      const add = parts[i + 1]?.added ? lines(parts[++i].value) : []
      for (let j = 0; j < Math.max(del.length, add.length); j++) {
        rows.push({
          type: 'change',
          l: j < del.length ? { n: ln++, t: del[j] } : null,
          r: j < add.length ? { n: rn++, t: add[j] } : null,
        })
      }
    } else {
      for (const t of lines(p.value)) rows.push({ type: 'change', l: null, r: { n: rn++, t } })
    }
  }
  return rows
}

// Resalta a nivel palabra cuando una línea vieja y una nueva están emparejadas
function wordDiff(a, b) {
  let left = '', right = ''
  for (const p of diffWordsWithSpace(a, b)) {
    if (p.added) right += `<mark>${esc(p.value)}</mark>`
    else if (p.removed) left += `<mark>${esc(p.value)}</mark>`
    else { left += esc(p.value); right += esc(p.value) }
  }
  return [left, right]
}

function cell(side, content, kind) {
  if (!side) return `<td class="num empty"></td><td class="code empty"></td>`
  return `<td class="num">${side.n}</td><td class="code ${kind}">${content}</td>`
}

function renderRow(row, focused = false) {
  const tr = focused ? '<tr class="focus">' : '<tr>'
  if (row.type === 'same') {
    const t = esc(row.l.t)
    return `${tr}${cell(row.l, t, '')}${cell(row.r, t, '')}</tr>`
  }
  let [l, r] = [row.l && esc(row.l.t), row.r && esc(row.r.t)]
  if (row.l && row.r) [l, r] = wordDiff(row.l.t, row.r.t)
  return `${tr}${cell(row.l, l, 'del')}${cell(row.r, r, 'add')}</tr>`
}

function renderDiffTable(rows, focus = null) {
  // Colapsa los bloques largos sin cambios dejando CONTEXT líneas alrededor
  // (y alrededor de la línea a la que se salta desde la búsqueda, para que no quede plegada)
  const focusIdx = focus ? rows.findIndex((row) => row[focus.side]?.n === focus.n) : -1
  const keep = rows.map(() => false)
  rows.forEach((row, i) => {
    if (row.type === 'change' || i === focusIdx) for (let k = i - CONTEXT; k <= i + CONTEXT; k++) if (rows[k]) keep[k] = true
  })
  let html = '', i = 0
  while (i < rows.length) {
    if (keep[i]) { html += renderRow(rows[i], i === focusIdx); i++; continue }
    const start = i
    while (i < rows.length && !keep[i]) i++
    const hidden = rows.slice(start, i)
    if (hidden.length <= 2) { html += hidden.map((row) => renderRow(row)).join(''); continue }
    html += `<tbody class="fold" data-rows="${encodeURIComponent(hidden.map((row) => renderRow(row)).join(''))}"><tr><td colspan="4">⋯ ${hidden.length} líneas sin cambios (click para expandir)</td></tr></tbody>`
  }
  return `<table class="diff"><colgroup><col class="n"><col><col class="n"><col></colgroup>
    <thead><tr><th colspan="2">Código viejo</th><th colspan="2">Código nuevo</th></tr></thead>${html}</table>`
}

async function renderViewer() {
  if (view === 'search' && active !== null) return renderSearch()
  if (!selected || active === null) return
  const focus = focusLine
  focusLine = null
  const file = await api(`/api/file?session=${active}&path=${encodeURIComponent(selected)}`)
  const labels = { added: 'Archivo nuevo', deleted: 'Archivo eliminado', modified: 'Modificado', unchanged: 'Sin cambios' }
  let body
  if (file.old?.binary || file.new?.binary) body = `<div class="empty">Archivo binario o muy grande: no se muestra el diff.</div>`
  else body = renderDiffTable(buildRows(file.old?.text ?? '', file.new?.text ?? ''), focus)

  const base = activeSession()?.base
  body = body.replace('>Código viejo<', `>Código viejo${base ? ` <span class="th-base">(base: ${esc(base)})</span>` : ''}<`)
  const back = symbolQuery ? `<button class="back-search" data-back title="Volver a los resultados">← ${esc(symbolQuery)}</button>` : ''
  const scroll = $('#viewer').scrollTop
  $('#viewer').innerHTML = `<div class="file-header">${back}<span class="badge ${file.status}">${labels[file.status]}</span> ${esc(file.path)}</div>${body}`
  $('#viewer').scrollTop = scroll
  $('#viewer .focus')?.scrollIntoView({ block: 'center' })
}

// ---------- Búsqueda de símbolos (dónde se usa, y si es nuevo o ya existía) ----------

const SYMBOL_STATUS = {
  new: ['Nuevo', 'No aparece en el código viejo: se agregó en estos cambios.'],
  existing: ['Ya existía', 'Ya estaba en el código viejo.'],
  removed: ['Eliminado', 'Solo aparece en el código viejo: se dejó de usar en estos cambios.'],
  none: ['Sin resultados', 'No aparece ni en el código viejo ni en el nuevo.'],
}
const DEF_STATUS = { new: 'definición nueva', existing: 'definición existente', removed: 'definición eliminada' }
const USE_KIND = { added: '+ nuevo', unchanged: 'existente', removed: '− eliminado' }

function highlightSymbol(text, name) {
  const re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g')
  return text.split(re).map(esc).join(`<mark>${esc(name)}</mark>`)
}

async function renderSearch() {
  const id = active
  let result
  try {
    result = await api(`/api/search?session=${id}&q=${encodeURIComponent(symbolQuery)}`)
  } catch (err) {
    $('#viewer').innerHTML = `<div class="empty">⚠ ${esc(err.message)}</div>`
    return
  }
  if (id !== active || view !== 'search') return // se cambió de tab o de vista mientras buscaba

  const onlyChanges = $('#only-changes').checked
  const [label, help] = SYMBOL_STATUS[result.status]
  const base = activeSession()?.base
  const c = result.counts
  const summary = [
    c.added && `<b class="added">${c.added} ${c.added === 1 ? 'uso nuevo' : 'usos nuevos'}</b>`,
    c.unchanged && `${c.unchanged} ${c.unchanged === 1 ? 'existente' : 'existentes'}`,
    c.removed && `<b class="deleted">${c.removed} ${c.removed === 1 ? 'eliminado' : 'eliminados'}</b>`,
  ].filter(Boolean).join(' · ')

  const line = (f, m) => `<div class="sr-line ${m.kind}" data-file="${esc(f.path)}" data-side="${m.kind === 'removed' ? 'l' : 'r'}" data-n="${m.line}">
      <span class="sr-kind">${USE_KIND[m.kind]}</span>
      <span class="sr-n">${m.line}</span>
      <code>${highlightSymbol(m.text, result.name)}</code>
      ${m.def ? '<span class="sr-def">definición</span>' : ''}
    </div>`

  // "Solo cambios" también aplica acá: esconde los usos que no cambiaron (salvo las definiciones)
  const visible = (m) => !onlyChanges || m.kind !== 'unchanged' || m.def
  const files = result.files
    .map((f) => ({ ...f, shown: f.matches.filter(visible) }))
    .filter((f) => f.shown.length)
  const hidden = result.files.reduce((n, f) => n + f.matches.length, 0) - files.reduce((n, f) => n + f.shown.length, 0)

  const labels = { added: 'nuevo', deleted: 'eliminado', modified: 'modificado', unchanged: '' }
  $('#viewer').innerHTML = `
    <div class="file-header search-header">
      <code class="sr-name">${esc(result.name)}</code>
      <span class="sym-status ${result.status}" title="${esc(help)}">${label}</span>
      ${result.definition ? `<span class="sr-defstatus ${result.definition}">${DEF_STATUS[result.definition]}</span>` : ''}
      <span class="sr-summary">${summary}</span>
    </div>
    <div class="search-results">
      <p class="sr-help">${esc(help)} Código viejo = ${base ? `merge-base con <code>${esc(base)}</code>` : 'foto inicial'}.</p>
      ${files.map((f) => `<div class="sr-file">
          <div class="sr-path">${esc(f.path)} ${labels[f.status] ? `<span class="badge ${f.status}">${labels[f.status]}</span>` : ''}</div>
          ${f.shown.map((m) => line(f, m)).join('')}
        </div>`).join('')}
      ${hidden ? `<p class="sr-help">${hidden} ${hidden === 1 ? 'uso existente oculto' : 'usos existentes ocultos'} por "Solo cambios".</p>` : ''}
      ${result.truncated ? '<p class="sr-help">Se muestran los primeros 1000 resultados.</p>' : ''}
    </div>`
}

function searchSymbolName(name) {
  symbolQuery = name.trim()
  $('#symbol-input').value = symbolQuery
  if (!symbolQuery) {
    view = 'file'
    if (!selected) $('#viewer').innerHTML = '<div class="empty">Elegí un archivo del árbol o editá uno para verlo acá.</div>'
  } else view = 'search'
  $('#viewer').scrollTop = 0
  renderViewer()
}

$('#symbol-form').addEventListener('submit', (e) => {
  e.preventDefault()
  searchSymbolName($('#symbol-input').value)
})
$('#symbol-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') e.target.blur()
})

// Ctrl+Shift+F: ir al buscador de símbolos (con la palabra seleccionada, si hay)
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'f') return
  e.preventDefault()
  const sel = getSelection().toString().trim()
  if (/^[\w$]+$/.test(sel)) return searchSymbolName(sel)
  $('#symbol-input').focus()
  $('#symbol-input').select()
})

// ---------- Estado / eventos ----------

let restored = false // evita pisar las carpetas guardadas antes de restaurarlas

// Guarda las carpetas abiertas y la tab activa en la URL (?dir=...&dir=...&active=...)
// para que sobrevivan a un refresh. localStorage queda como respaldo si se abre sin query.
const encodePath = (p) => encodeURIComponent(p).replaceAll('%2F', '/')

function saveFolders() {
  const roots = [...new Set(state.sessions.map((s) => s.root))]
  const params = roots.map((r) => `dir=${encodePath(r)}`)
  const session = activeSession()
  if (session) params.push(`active=${encodePath(session.root)}`)
  const query = params.length ? `?${params.join('&')}` : ''
  if (query !== location.search) history.replaceState(null, '', location.pathname + query + location.hash)
  try { localStorage.setItem('diffs-viewer:roots', JSON.stringify(roots)) } catch {}
}

async function refresh() {
  const prev = activeSession()
  state = await api(`/api/state?session=${active ?? ''}`)
  const cur = activeSession()

  // Si la tab activa era la branch en vivo y se hizo checkout, seguimos a la branch nueva.
  // Si no hay tab activa (o se cerró), pasamos a una en vivo.
  if (!cur || (prev?.live && !cur.live)) {
    const next =
      state.sessions.find((s) => prev && s.root === prev.root && s.live) ??
      (cur ? null : state.sessions.find((s) => s.live) ?? state.sessions[0])
    if (next) return selectTab(next.id)
    if (!cur) active = null
  }

  const session = activeSession()
  $('#status').textContent = session ? (session.live ? '● en vivo' : '❄ congelada') : ''
  $('#status').className = session && !session.live ? 'frozen' : ''
  $('#status').title = ''
  if (restored) saveFolders()
  renderTabs()
  renderTree()
  renderBaseSelect()
  renderCheckoutSelect()
}

// ---------- Selectores de branch (pararse en una / comparar contra otra) ----------

let branchList = []
let localBranches = []
let remoteBranches = []
let branchesFor = null // tab para la que se cargó branchList

// Repinta un <select> solo si cambiaron sus opciones, para no cerrar el desplegable si está abierto
function setOptions(select, key, html) {
  if (select.dataset.key === key) return
  select.innerHTML = html
  select.dataset.key = key
}

function renderCheckoutSelect() {
  const session = activeSession()
  const select = $('#checkout')
  select.disabled = !session?.branch
  if (!session?.branch) return setOptions(select, '', '')
  // Remotas que todavía no tienen branch local (origin/x -> se crea x)
  const remote = remoteBranches.filter((r) => !localBranches.includes(r.slice(r.indexOf('/') + 1)))
  const local = localBranches.includes(session.branch) ? localBranches : [session.branch, ...localBranches]
  const opts = (list) => list.map((b) => `<option>${esc(b)}</option>`).join('')
  setOptions(select, `${local.join('\n')}|${remote.join('\n')}`,
    `<optgroup label="Locales">${opts(local)}</optgroup>` + (remote.length ? `<optgroup label="Remotas">${opts(remote)}</optgroup>` : ''))
  select.value = session.branch
  syncPicker(select)
}

function renderBaseSelect() {
  const session = activeSession()
  const select = $('#base')
  select.disabled = !session?.live || !session.branch
  select.title = session && !session.live ? 'Solo se puede cambiar en una tab en vivo' : ''
  const list = session?.base && !branchList.includes(session.base) ? [session.base, ...branchList] : branchList
  setOptions(select, list.join('\n'), `<option value="">Foto inicial</option>` + list.map((b) => `<option>${esc(b)}</option>`).join(''))
  select.value = session?.base ?? ''
  syncPicker(select)
}

// Se piden a git cada vez que se abre el selector, así aparecen las branches recién creadas
async function loadBranches() {
  if (active === null) return
  const id = active
  const { branches, local, remote } = await api(`/api/branches?session=${id}`)
  if (id !== active) return
  branchList = branches
  localBranches = local
  remoteBranches = remote
  branchesFor = id
  renderBaseSelect()
  renderCheckoutSelect()
}

// ---------- Desplegable con buscador ----------
// Cada <select> de branches queda oculto como fuente de verdad (opciones, valor y evento change);
// encima se dibuja un botón que abre una lista filtrable.

const pickers = new Map() // select -> { button, pop, input, list, items, hl }

function createPicker(select) {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'picker-btn' })
  const pop = Object.assign(document.createElement('div'), { className: 'picker-pop', hidden: true })
  pop.innerHTML = '<input class="picker-search" placeholder="Buscar branch…" spellcheck="false" /><ul class="picker-list" role="listbox"></ul>'
  select.after(button, pop)
  const p = { button, pop, input: pop.querySelector('input'), list: pop.querySelector('ul'), items: [], hl: 0 }
  pickers.set(select, p)

  button.addEventListener('click', () => (pop.hidden ? openPicker(select) : closePicker(select)))
  p.input.addEventListener('input', () => { p.hl = 0; renderPickerList(select) })
  p.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!p.items.length) return
      p.hl = (p.hl + (e.key === 'ArrowDown' ? 1 : -1) + p.items.length) % p.items.length
      renderPickerList(select)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (p.items[p.hl]) choosePicker(select, p.items[p.hl].value)
    } else if (e.key === 'Escape') {
      closePicker(select)
      button.focus()
    }
  })
  p.list.addEventListener('mousedown', (e) => e.preventDefault()) // no perder el foco del buscador
  p.list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]')
    if (li) choosePicker(select, p.items[Number(li.dataset.i)].value)
  })
}

// Resalta los términos buscados dentro del nombre de la branch
function highlightTerms(text, terms) {
  if (!terms.length) return esc(text)
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('')
}

function renderPickerList(select) {
  const p = pickers.get(select)
  // Todas las palabras tienen que aparecer, en cualquier orden: "fix login" encuentra "feature/login-fix"
  const terms = p.input.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (o) => terms.every((t) => o.text.toLowerCase().includes(t))
  p.items = []
  let html = ''
  const addOptions = (options, group) => {
    const found = [...options].filter(matches)
    if (!found.length) return
    if (group) html += `<li class="picker-group">${esc(group)}</li>`
    for (const o of found) {
      const i = p.items.push({ value: o.value }) - 1
      const cls = [i === p.hl && 'hl', o.value === select.value && 'current'].filter(Boolean).join(' ')
      html += `<li role="option" data-i="${i}" class="${cls}" title="${esc(o.text)}">${highlightTerms(o.text, terms)}</li>`
    }
  }
  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') addOptions(child.children, child.label)
    else addOptions([child])
  }
  p.list.innerHTML = html || '<li class="picker-empty">Ninguna branch coincide</li>'
  p.list.querySelector('.hl')?.scrollIntoView({ block: 'nearest' })
}

// Actualiza el botón (y la lista si está abierta) cuando cambian las opciones o el valor del <select>
function syncPicker(select) {
  const p = pickers.get(select)
  if (!p) return
  p.button.textContent = select.selectedOptions[0]?.text ?? '—'
  p.button.disabled = select.disabled
  if (select.disabled) closePicker(select)
  else if (!p.pop.hidden) renderPickerList(select)
}

function openPicker(select) {
  for (const other of pickers.keys()) if (other !== select) closePicker(other)
  const p = pickers.get(select)
  p.input.value = ''
  p.hl = Math.max(0, [...select.options].findIndex((o) => o.value === select.value))
  p.pop.hidden = false
  renderPickerList(select)
  p.input.focus()
  loadBranches() // se piden a git al abrir, así aparecen las branches recién creadas
}

function closePicker(select) {
  pickers.get(select).pop.hidden = true
}

function choosePicker(select, value) {
  closePicker(select)
  if (value === select.value) return
  select.value = value
  syncPicker(select)
  select.dispatchEvent(new Event('change'))
}

for (const sel of ['#base', '#checkout']) createPicker($(sel))
document.addEventListener('mousedown', (e) => {
  for (const [select, p] of pickers) if (!p.pop.hidden && !select.parentElement.contains(e.target)) closePicker(select)
})

$('#checkout').addEventListener('change', async (e) => {
  const branch = e.target.value
  $('#status').textContent = `cambiando a ${branch}…`
  try {
    const { session } = await api('/api/checkout', { session: active, branch })
    await selectTab(session)
  } catch (err) {
    $('#status').textContent = `⚠ ${err.message.split('\n')[0]}`
    $('#status').title = err.message
    renderCheckoutSelect() // vuelve a mostrar la branch en la que sigue parada
  }
})

$('#base').addEventListener('change', async (e) => {
  $('#status').textContent = 'calculando…'
  try {
    await api('/api/base', { session: active, base: e.target.value || null })
  } catch (err) {
    $('#status').textContent = `⚠ ${err.message}`
  }
  await refresh()
  renderViewer()
})

// ---------- Ancho del árbol (arrastrando la barra entre el árbol y el diff) ----------

const ASIDE_KEY = 'diffs-viewer:aside-width'
const ASIDE_DEFAULT = 300
const ASIDE_MIN = 180
const VIEWER_MIN = 320 // lo mínimo que se le deja al diff

let asideWanted = ASIDE_DEFAULT // el ancho elegido; el real puede ser menor si la ventana es angosta

function setAsideWidth(px, save = true) {
  asideWanted = Math.round(Math.max(px, ASIDE_MIN))
  const w = Math.max(ASIDE_MIN, Math.min(asideWanted, window.innerWidth - VIEWER_MIN))
  document.documentElement.style.setProperty('--aside-w', `${w}px`)
  if (save) try { localStorage.setItem(ASIDE_KEY, asideWanted) } catch {}
}

try { const saved = Number(localStorage.getItem(ASIDE_KEY)); if (saved) setAsideWidth(saved, false) } catch {}

const resizer = $('#resizer')
resizer.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  resizer.setPointerCapture(e.pointerId)
  document.body.classList.add('resizing')
  const left = $('aside').getBoundingClientRect().left
  const move = (ev) => setAsideWidth(Math.min(ev.clientX - left, window.innerWidth - VIEWER_MIN))
  const up = () => {
    document.body.classList.remove('resizing')
    resizer.removeEventListener('pointermove', move)
    resizer.removeEventListener('pointerup', up)
    resizer.removeEventListener('pointercancel', up)
  }
  resizer.addEventListener('pointermove', move)
  resizer.addEventListener('pointerup', up)
  resizer.addEventListener('pointercancel', up)
})
resizer.addEventListener('dblclick', () => {
  setAsideWidth(ASIDE_DEFAULT, false)
  try { localStorage.removeItem(ASIDE_KEY) } catch {}
})
// Con el foco en la barra, ←/→ achican o agrandan (Shift = pasos más grandes)
resizer.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const step = (e.shiftKey ? 80 : 20) * (e.key === 'ArrowLeft' ? -1 : 1)
  setAsideWidth($('aside').getBoundingClientRect().width + step)
})
// Si la ventana se achica, que el diff no quede aplastado (y al agrandarla, vuelve al ancho elegido)
window.addEventListener('resize', () => setAsideWidth(asideWanted, false))

$('#tree').addEventListener('click', (e) => {
  const el = e.target.closest('.file')
  if (!el) return
  view = 'file'
  selected = el.dataset.path
  $('#viewer').scrollTop = 0
  renderTree()
  renderViewer()
})

$('#tabs').addEventListener('click', async (e) => {
  const close = e.target.closest('[data-close]')
  if (close) {
    await api('/api/close', { session: Number(close.dataset.close) })
    return refresh()
  }
  const ghost = e.target.closest('[data-add]')
  if (ghost) return addFolder(ghost.dataset.add).catch((err) => ($('#status').textContent = `⚠ ${err.message}`))
  const tab = e.target.closest('.tab')
  if (tab && Number(tab.dataset.id) !== active) selectTab(Number(tab.dataset.id))
})

// Alt+1..9 para saltar entre tabs
document.addEventListener('keydown', (e) => {
  if (!e.altKey || !/^[1-9]$/.test(e.key)) return
  const s = state.sessions[Number(e.key) - 1]
  if (s) { e.preventDefault(); selectTab(s.id) }
})

$('#viewer').addEventListener('click', (e) => {
  if (e.target.closest('[data-back]')) {
    view = 'search'
    $('#viewer').scrollTop = 0
    return renderViewer()
  }
  const hit = e.target.closest('.sr-line')
  if (hit) {
    view = 'file'
    selected = hit.dataset.file
    focusLine = { side: hit.dataset.side, n: Number(hit.dataset.n) }
    renderTree()
    return renderViewer()
  }
  const fold = e.target.closest('.fold')
  if (fold) fold.outerHTML = `<tbody>${decodeURIComponent(fold.dataset.rows)}</tbody>`
})

const RECENT_KEY = 'diffs-viewer:recent'
const loadRecent = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] }
}

async function addFolder(dir) {
  $('#status').textContent = 'escaneando…'
  const { session } = await api('/api/root', { dir })
  await selectTab(session)
  const root = activeSession()?.root
  if (root) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([root, ...loadRecent().filter((r) => r !== root)].slice(0, 8))) } catch {}
  }
}

async function submitFolder(dir) {
  try {
    await addFolder(dir)
    $('#root-input').value = ''
    closeSuggestions()
  } catch (err) {
    $('#status').textContent = `⚠ ${err.message}`
  }
}

// ---------- Autocompletado de rutas ----------

const input = $('#root-input')
const list = $('#path-suggestions')
let suggestions = [] // [{ name, path, git, recent? }]
let highlighted = -1
let suggestSeq = 0

function closeSuggestions() {
  list.hidden = true
  input.setAttribute('aria-expanded', 'false')
  highlighted = -1
}

function renderSuggestions(more) {
  if (!suggestions.length) return closeSuggestions()
  list.innerHTML = suggestions
    .map((s, i) => `<li role="option" data-i="${i}" class="${i === highlighted ? 'hl' : ''} ${s.recent ? 'recent' : ''}" title="${esc(s.path)}">
        <span class="sug-icon">${s.recent ? '🕘' : s.git ? '⎇' : '📁'}</span>
        <span class="sug-name">${esc(s.recent ? s.path : s.name)}</span>
        ${s.recent ? '' : `<button type="button" class="sug-enter" data-enter="${i}" title="Ver subcarpetas (Tab)">›</button>`}
      </li>`)
    .join('') + (more ? '<li class="more">…seguí escribiendo para filtrar</li>' : '')
  list.hidden = false
  input.setAttribute('aria-expanded', 'true')
  list.querySelector('.hl')?.scrollIntoView({ block: 'nearest' })
}

async function updateSuggestions() {
  const value = input.value
  const seq = ++suggestSeq
  const { entries, more } = await api(`/api/dirs?path=${encodeURIComponent(value)}`).catch(() => ({ entries: [] }))
  if (seq !== suggestSeq) return // llegó tarde: ya se escribió otra cosa
  const open = new Set(state.sessions.map((s) => s.root))
  const recentDirs = value ? [] : loadRecent().filter((r) => !open.has(r)).map((r) => ({ path: r, recent: true }))
  suggestions = [...recentDirs, ...entries]
  highlighted = -1
  renderSuggestions(more)
}

// Reemplaza el último tramo de lo escrito por la carpeta elegida y sigue hacia adentro
function enterSuggestion(s) {
  const value = input.value || '~/'
  input.value = s.recent ? `${s.path}/` : value.slice(0, value.lastIndexOf('/') + 1) + s.name + '/'
  input.focus()
  updateSuggestions()
}

let suggestTimer
input.addEventListener('input', () => {
  clearTimeout(suggestTimer)
  suggestTimer = setTimeout(updateSuggestions, 80)
})
input.addEventListener('focus', updateSuggestions)
input.addEventListener('blur', () => setTimeout(closeSuggestions, 150)) // deja llegar el click en la lista

input.addEventListener('keydown', (e) => {
  const opened = !list.hidden && suggestions.length
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!opened) return updateSuggestions()
    e.preventDefault()
    // Cicla entre -1 (nada elegido, Enter usa lo escrito) y la última sugerencia
    const n = suggestions.length + 1
    highlighted = ((highlighted + 1 + (e.key === 'ArrowDown' ? 1 : -1) + n) % n) - 1
    renderSuggestions()
  } else if (e.key === 'Tab' && opened && !e.shiftKey) {
    e.preventDefault()
    enterSuggestion(suggestions[Math.max(highlighted, 0)])
  } else if (e.key === 'Enter' && opened && highlighted >= 0) {
    e.preventDefault()
    submitFolder(suggestions[highlighted].path)
  } else if (e.key === 'Escape') {
    closeSuggestions()
  }
})

list.addEventListener('mousedown', (e) => e.preventDefault()) // no perder el foco del input
list.addEventListener('click', (e) => {
  const enter = e.target.closest('[data-enter]')
  if (enter) return enterSuggestion(suggestions[Number(enter.dataset.enter)])
  const item = e.target.closest('[data-i]')
  if (item) submitFolder(suggestions[Number(item.dataset.i)].path)
})

$('#root-form').addEventListener('submit', (e) => {
  e.preventDefault()
  submitFolder(input.value.trim())
})

$('#pick').addEventListener('click', async () => {
  $('#status').textContent = 'elegí una carpeta en el explorador…'
  try {
    const { dir } = await api('/api/pick', { start: input.value.trim() || activeSession()?.root })
    if (dir) await submitFolder(dir)
    else $('#status').textContent = ''
  } catch (err) {
    $('#status').textContent = `⚠ ${err.message}`
  }
})

$('#only-changes').addEventListener('change', () => {
  renderTree()
  if (view === 'search') renderViewer()
})

$('#reset').addEventListener('click', async () => {
  if (active === null) return
  await api('/api/reset', { session: active })
  await refresh()
  renderViewer()
})

let timer
let needViewer = false
import.meta.hot.on('diffs:update', ({ session, file }) => {
  if (file && session === active) {
    recent.add(file)
    setTimeout(() => { recent.delete(file); renderTree() }, 1500)
    if (!selected) selected = file
  }
  needViewer ||= !file || (session === active && file === selected)
  // Agrupa ráfagas de eventos (ej: guardar muchos archivos juntos)
  clearTimeout(timer)
  timer = setTimeout(async () => {
    await refresh()
    if (needViewer) renderViewer()
    needViewer = false
  }, 60)
})

// Al abrir: reabre las carpetas de la URL (o, si no hay, las últimas guardadas)
const params = new URLSearchParams(location.search)
let wanted = params.getAll('dir')
if (!wanted.length) {
  try { wanted = JSON.parse(localStorage.getItem('diffs-viewer:roots') ?? '[]') } catch {}
}
await refresh()
const open = new Set(state.sessions.map((s) => s.root))
for (const dir of wanted) if (!open.has(dir)) await addFolder(dir).catch(() => {})
await refresh()
const activeRoot = params.get('active') ?? wanted.at(-1)
const target = state.sessions.find((s) => s.root === activeRoot && s.live) ?? state.sessions.find((s) => s.root === activeRoot)
if (target && target.id !== active) await selectTab(target.id)
restored = true
await refresh()
