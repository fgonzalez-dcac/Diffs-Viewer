// Plugin de Vite: observa una o más carpetas y avisa al navegador por websocket
// cada vez que un archivo cambia.
//
// Cada "sesión" (una tab en la UI) es una carpeta + branch, con su propia foto
// inicial (baseline). Al hacer checkout, la sesión de la branch anterior queda
// congelada y se abre (o se reanuda) la de la branch nueva.
import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import chokidar from 'chokidar'
import { diffLines } from 'diff'

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache', 'coverage', '.venv', '__pycache__'])
const MAX_SIZE = 1024 * 1024 // 1MB: archivos más grandes se tratan como binarios
const CHECKOUT_SETTLE_MS = 400 // espera a que git termine de escribir archivos tras un checkout

// Una subcarpeta con su propio .git es otro worktree (o submódulo): tiene su propia tab
const isNestedRepo = (dir) => fs.existsSync(path.join(dir, '.git'))

const toContent = (buf) =>
  buf.length > MAX_SIZE || buf.includes(0) ? { binary: true } : { text: buf.toString('utf8') }

const isIgnoredRel = (rel) => rel.split('/').some((part) => IGNORED_DIRS.has(part))

function readText(abs) {
  try {
    const stat = fs.statSync(abs)
    if (!stat.isFile()) return undefined
    if (stat.size > MAX_SIZE) return { binary: true }
    return toContent(fs.readFileSync(abs))
  } catch {
    return undefined
  }
}

// Lee todos los archivos de la carpeta: rel -> {text} | {binary}
function scan(root) {
  const files = new Map()
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue // en un worktree, .git es un archivo
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!isNestedRepo(abs)) walk(abs)
      } else if (e.isFile()) {
        const content = readText(abs)
        if (content) files.set(path.relative(root, abs).split(path.sep).join('/'), content)
      }
    }
  }
  walk(root)
  return files
}

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

// key identifica la sesión; label es lo que se muestra. Sin repo: ambos null.
function currentBranch(cwd) {
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch && branch !== 'HEAD') return { key: branch, label: branch }
  const sha = git(cwd, 'rev-parse', '--short', 'HEAD')
  return sha ? { key: '(detached)', label: `detached @ ${sha}` } : { key: null, label: null }
}

// Branches locales y remotas, las más recientes primero
function branches(cwd) {
  const out = git(cwd, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes')
  const refs = (out ?? '').split('\n').filter((ref) => ref && !ref.endsWith('/HEAD')) // origin/HEAD es un alias
  const short = (prefix) => refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length))
  const local = short('refs/heads/')
  return { all: refs.map((r) => r.replace(/^refs\/(heads|remotes)\//, '')), local, remote: short('refs/remotes/') }
}

// git switch a una branch local, o crea la local siguiendo a una remota (origin/x -> x).
// Devuelve el mensaje de error de git si falla.
function switchBranch(cwd, branch) {
  const isLocal = git(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) !== null
  const args = isLocal ? ['switch', branch] : ['switch', '--track', branch]
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return null
  } catch (err) {
    return (err.stderr || err.message).trim()
  }
}

// Arma el "código viejo" desde git: los archivos como estaban en el merge-base entre
// HEAD y la branch base (lo mismo que muestra un PR). Lo que git no ve como cambiado
// se toma igual que en disco.
function baselineFromBranch(cwd, current, base) {
  const mergeBase = git(cwd, 'merge-base', 'HEAD', base)
  if (!mergeBase) throw new Error(`No existe la branch ${base} o no tiene historia en común con esta`)
  const list = (...args) => (git(cwd, ...args) ?? '').split('\0').filter((f) => f && !isIgnoredRel(f))

  const baseline = new Map(current)
  for (const f of list('ls-files', '--others', '--exclude-standard', '-z')) baseline.delete(f)
  for (const f of list('diff', '--name-only', '--no-renames', '--relative', '-z', mergeBase)) {
    try {
      const buf = execFileSync('git', ['show', `${mergeBase}:./${f}`], { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      baseline.set(f, toContent(buf))
    } catch {
      baseline.delete(f) // no existía en la base: es un archivo nuevo
    }
  }
  return baseline
}

// Worktrees del repo al que pertenece la carpeta: [{ path, branch }]
function worktrees(cwd) {
  const out = git(cwd, 'worktree', 'list', '--porcelain')
  if (!out) return []
  return out.split('\n\n').flatMap((block) => {
    const lines = block.split('\n')
    const get = (k) => lines.find((l) => l.startsWith(k))?.slice(k.length + 1)
    const wtPath = get('worktree')
    if (!wtPath || lines.includes('bare') || get('prunable') !== undefined) return []
    const branch = get('branch')?.replace('refs/heads/', '') ?? `detached @ ${get('HEAD')?.slice(0, 7)}`
    return [{ path: path.resolve(wtPath), branch }]
  })
}

const expandHome = (p) => p.replace(/^~(?=\/|$)/, process.env.HOME)
const MAX_SUGGESTIONS = 50

// Autocompletado de rutas: "~/Proy" -> subcarpetas de ~ que empiezan con "Proy".
// Si la ruta termina en "/", lista todo lo que hay adentro.
function suggestDirs(input) {
  const typed = expandHome(input || '~/')
  const abs = path.resolve(typed)
  const [dir, prefix] = typed.endsWith('/') ? [abs, ''] : [path.dirname(abs), path.basename(abs)]
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return { dir, entries: [] } }
  const lower = prefix.toLowerCase()
  const list = entries
    .filter((e) => (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name), { throwIfNoEntry: false })?.isDirectory())))
    .filter((e) => (prefix.startsWith('.') || !e.name.startsWith('.')) && e.name.toLowerCase().startsWith(lower))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), git: isNestedRepo(path.join(dir, e.name)) }))
    // Primero los repos, después alfabético
    .sort((a, b) => b.git - a.git || a.name.localeCompare(b.name))
  return { dir, entries: list.slice(0, MAX_SUGGESTIONS), more: list.length > MAX_SUGGESTIONS }
}

// Abre el selector de carpetas nativo del sistema. Devuelve la ruta, o null si se canceló.
// Es async para no trabar el server mientras el diálogo está abierto.
async function pickDir(start) {
  const initial = path.join(fs.existsSync(start ?? '') ? start : process.env.HOME, '/')
  const dialogs = [
    ['zenity', ['--file-selection', '--directory', '--title=Elegí la carpeta a observar', `--filename=${initial}`]],
    ['kdialog', ['--getexistingdirectory', initial, '--title', 'Elegí la carpeta a observar']],
    ['osascript', ['-e', `POSIX path of (choose folder with prompt "Elegí la carpeta a observar" default location POSIX file "${initial}")`]],
  ]
  for (const [cmd, args] of dialogs) {
    try {
      const { stdout } = await promisify(execFile)(cmd, args, { encoding: 'utf8' })
      return stdout.trim().replace(/(.)\/$/, '$1') || null
    } catch (err) {
      if (err.code === 'ENOENT') continue // no está instalado: probamos el siguiente
      return null // el usuario canceló
    }
  }
  throw new Error('No hay un selector de carpetas disponible (instalá zenity o kdialog)')
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MAX_MATCHES = 1000
const MAX_LINE = 300

// Regex de "acá se define NAME": declaraciones de JS/TS y de otros lenguajes comunes,
// métodos (`name(args) {`) y asignaciones de funciones (`name = () =>`, `name: function`).
function definitionRe(name) {
  const n = escapeRe(name)
  const mods = String.raw`(?:(?:export|default|declare|abstract|async|public|private|protected|static|readonly|pub)\s+)*`
  return new RegExp([
    String.raw`^\s*${mods}(?:function\s*\*?|class|const|let|var|type|interface|enum|def|fn|func|struct)\s+${n}(?![\w$])`,
    String.raw`^\s*${mods}(?:get\s+|set\s+)?${n}\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{=]*)?\{`,
    String.raw`^\s*(?:this\.)?${n}\s*[:=]\s*(?:async\s*)?(?:function|\([^)]*\)\s*(?::[^=]*)?=>|[\w$]+\s*=>)`,
  ].join('|'))
}

// Busca dónde aparece un símbolo en el código viejo y en el nuevo de una tab, y clasifica
// cada aparición según el diff: 'added' (línea nueva), 'removed' (ya no está) o 'unchanged'.
function searchSymbol(session, name) {
  const word = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`)
  const isDef = definitionRe(name)
  const files = []
  let total = 0
  let truncated = false

  for (const file of [...new Set([...session.baseline.keys(), ...session.current.keys()])].sort()) {
    const old = session.baseline.get(file)?.text ?? ''
    const cur = session.current.get(file)?.text ?? ''
    if (!word.test(old) && !word.test(cur)) continue

    const matches = []
    const collect = (text, kind, first) => {
      text.replace(/\n$/, '').split('\n').forEach((line, i) => {
        if (!word.test(line)) return
        matches.push({
          kind,
          line: first + i, // número en el código nuevo (o en el viejo si se eliminó)
          text: line.trim().slice(0, MAX_LINE),
          def: isDef.test(line),
        })
      })
    }
    if (old === cur) collect(cur, 'unchanged', 1)
    else {
      let ln = 1, rn = 1
      for (const part of diffLines(old, cur)) {
        if (part.removed) collect(part.value, 'removed', ln)
        else collect(part.value, part.added ? 'added' : 'unchanged', rn)
        if (!part.added) ln += part.count
        if (!part.removed) rn += part.count
      }
    }
    if (!matches.length) continue // aparecía, pero no como palabra entera en ninguna línea
    total += matches.length
    files.push({ path: file, status: status(session, file), matches })
    if (total >= MAX_MATCHES) { truncated = true; break }
  }

  const all = files.flatMap((f) => f.matches)
  const count = (kind, pred = () => true) => all.filter((m) => m.kind === kind && pred(m)).length
  const inOld = all.some((m) => m.kind !== 'added')
  const inNew = all.some((m) => m.kind !== 'removed')
  const defOld = all.some((m) => m.def && m.kind !== 'added')
  const defNew = all.some((m) => m.def && m.kind !== 'removed')
  const classify = (before, after) => (before && after ? 'existing' : after ? 'new' : before ? 'removed' : null)

  // Primero los archivos con usos nuevos o eliminados: es lo que cambió
  const changed = (f) => f.matches.some((m) => m.kind !== 'unchanged')
  files.sort((a, b) => changed(b) - changed(a))

  return {
    name,
    status: classify(inOld, inNew) ?? 'none',
    definition: classify(defOld, defNew), // null si no se encontró dónde se define
    counts: { added: count('added'), unchanged: count('unchanged'), removed: count('removed') },
    files,
    truncated,
  }
}

function sameContent(a, b) {
  if (!a || !b) return a === b
  if (a.binary || b.binary) return a.binary === b.binary
  return a.text === b.text
}

function status(session, file) {
  const b = session.baseline.get(file)
  const c = session.current.get(file)
  if (!b) return 'added'
  if (!c) return 'deleted'
  return sameContent(b, c) ? 'unchanged' : 'modified'
}

export default function diffWatcher() {
  const roots = new Map() // carpeta absoluta -> { abs, key, label, settling, watcher, headWatcher }
  // id -> { id, root, key, label, baseline, current, snapshot, base }
  // snapshot: foto de cuando se abrió la tab; base: branch contra la que se compara (null = snapshot)
  const sessions = new Map()
  let nextId = 1
  let ws = null

  const notify = (session, file = null) => ws?.send('diffs:update', { session: session?.id ?? null, file })
  const isLive = (s) => roots.get(s.root)?.key === s.key
  const liveSession = (r) => [...sessions.values()].find((s) => s.root === r.abs && s.key === r.key)

  // Abre la sesión de la branch actual de la carpeta, o reanuda la que ya existía
  function openSession(r) {
    const disk = scan(r.abs)
    let s = liveSession(r)
    if (s) s.current = disk
    else {
      const snapshot = new Map(disk)
      s = { id: nextId++, root: r.abs, key: r.key, baseline: snapshot, snapshot, current: disk, base: null }
      sessions.set(s.id, s)
    }
    s.label = r.label
    return s
  }

  function onFile(r, abs, kind) {
    if (r.settling) return // en medio de un checkout: el rescan posterior lo resuelve
    const s = liveSession(r)
    if (!s) return
    const file = path.relative(r.abs, abs).split(path.sep).join('/')
    if (kind === 'unlink') s.current.delete(file)
    else if (kind === 'unlinkDir') {
      for (const f of s.current.keys()) if (f.startsWith(file + '/')) s.current.delete(f)
    } else {
      const content = readText(abs)
      if (!content) return
      s.current.set(file, content)
    }
    notify(s, kind === 'unlinkDir' ? null : file)
  }

  function onHeadChange(r) {
    r.settling = true
    clearTimeout(r.settleTimer)
    r.settleTimer = setTimeout(() => {
      r.settling = false
      const { key, label } = currentBranch(r.abs)
      r.key = key
      r.label = label
      openSession(r)
      notify(null)
    }, CHECKOUT_SETTLE_MS)
  }

  async function addRoot(abs) {
    const existing = roots.get(abs)
    if (existing) return liveSession(existing) ?? openSession(existing)

    const r = { abs, ...currentBranch(abs), settling: true }
    roots.set(abs, r)

    r.watcher = chokidar.watch(abs, {
      ignored: (p) =>
        path.relative(abs, p).split(path.sep).some((part) => IGNORED_DIRS.has(part)) || (p !== abs && isNestedRepo(p)),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
    })
    for (const kind of ['add', 'change', 'unlink', 'unlinkDir']) r.watcher.on(kind, (p) => onFile(r, p, kind))

    // .git está ignorado, así que miramos HEAD aparte para detectar cambios de branch
    const headFile = git(abs, 'rev-parse', '--path-format=absolute', '--git-path', 'HEAD')
    if (headFile) {
      try {
        r.headWatcher = fs.watch(path.dirname(headFile), (_, name) => name === 'HEAD' && onHeadChange(r))
      } catch {}
    }

    await new Promise((resolve) => r.watcher.once('ready', resolve))
    r.settling = false
    return openSession(r)
  }

  function closeSession(id) {
    const s = sessions.get(id)
    if (!s) return
    const r = roots.get(s.root)
    sessions.delete(id)
    // Si era la sesión en vivo, se deja de observar la carpeta
    if (r && isLive(s)) {
      r.watcher.close()
      r.headWatcher?.close()
      clearTimeout(r.settleTimer)
      roots.delete(s.root)
    }
  }

  function state(id) {
    const list = [...sessions.values()].map((s) => {
      const counts = { added: 0, modified: 0, deleted: 0, unchanged: 0 }
      for (const f of new Set([...s.baseline.keys(), ...s.current.keys()])) counts[status(s, f)]++
      return { id: s.id, root: s.root, name: path.basename(s.root), branch: s.label, base: s.base, live: isLive(s), counts }
    })
    const s = sessions.get(id)
    const files = s
      ? [...new Set([...s.baseline.keys(), ...s.current.keys()])].sort().map((f) => ({ path: f, status: status(s, f) }))
      : []
    // Otros worktrees de los repos observados que todavía no tienen tab
    const suggestions = new Map()
    for (const r of roots.values()) {
      if (r.key === null) continue
      for (const wt of worktrees(r.abs)) {
        if (!roots.has(wt.path)) suggestions.set(wt.path, { ...wt, name: path.basename(wt.path) })
      }
    }
    return { sessions: list, files, suggestions: [...suggestions.values()] }
  }

  function send(res, code, body) {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) }
      })
    })
  }

  return {
    name: 'diff-watcher',
    configureServer(server) {
      ws = server.ws
      if (process.env.WATCH_DIR) addRoot(path.resolve(process.env.WATCH_DIR)).then(() => notify(null))

      server.middlewares.use('/api', async (req, res) => {
        const url = new URL(req.url, 'http://x')
        const id = Number(url.searchParams.get('session'))

        if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, state(id))

        if (req.method === 'GET' && url.pathname === '/file') {
          const s = sessions.get(id)
          if (!s) return send(res, 404, { error: 'La tab ya no existe' })
          const file = url.searchParams.get('path')
          return send(res, 200, {
            path: file,
            status: status(s, file),
            old: s.baseline.get(file) ?? null,
            new: s.current.get(file) ?? null,
          })
        }

        if (req.method === 'GET' && url.pathname === '/dirs') {
          return send(res, 200, suggestDirs(url.searchParams.get('path')))
        }

        if (req.method === 'POST' && url.pathname === '/pick') {
          const { start } = await readBody(req)
          try {
            return send(res, 200, { dir: await pickDir(start && path.resolve(expandHome(start))) })
          } catch (err) {
            return send(res, 400, { error: err.message })
          }
        }

        if (req.method === 'GET' && url.pathname === '/search') {
          const s = sessions.get(id)
          if (!s) return send(res, 404, { error: 'La tab ya no existe' })
          const name = (url.searchParams.get('q') ?? '').trim()
          if (!name) return send(res, 400, { error: 'Escribí el nombre de una función o constante' })
          return send(res, 200, searchSymbol(s, name))
        }

        if (req.method === 'POST' && url.pathname === '/root') {
          const { dir } = await readBody(req)
          const abs = dir && path.resolve(expandHome(dir))
          if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            return send(res, 400, { error: `No existe la carpeta: ${dir}` })
          }
          const s = await addRoot(abs)
          notify(null)
          return send(res, 200, { session: s.id })
        }

        if (req.method === 'POST' && url.pathname === '/reset') {
          // Acepta los cambios: lo actual pasa a ser el nuevo "código viejo"
          const { session } = await readBody(req)
          const s = sessions.get(session)
          if (s) {
            s.snapshot = s.baseline = new Map(s.current)
            s.base = null
          }
          notify(null)
          return send(res, 200, {})
        }

        if (req.method === 'GET' && url.pathname === '/branches') {
          const s = sessions.get(id)
          const list = s ? branches(s.root) : { all: [], local: [], remote: [] }
          return send(res, 200, { base: s?.base ?? null, branches: list.all, local: list.local, remote: list.remote })
        }

        if (req.method === 'POST' && url.pathname === '/checkout') {
          // Se para en otra branch dentro de la carpeta de la tab
          const { session, branch } = await readBody(req)
          const s = sessions.get(session)
          if (!s || !branch) return send(res, 400, { error: 'Falta la tab o la branch' })
          const error = switchBranch(s.root, branch)
          if (error) return send(res, 400, { error })

          // Abrimos ya la tab de la branch nueva (el watcher de HEAD también se entera, pero más tarde)
          const r = roots.get(s.root)
          if (!r) return send(res, 200, { session: (await addRoot(s.root)).id })
          Object.assign(r, currentBranch(r.abs))
          const next = openSession(r)
          notify(null)
          return send(res, 200, { session: next.id })
        }

        if (req.method === 'POST' && url.pathname === '/base') {
          // Cambia contra qué se compara la tab: una branch, o null para volver a la foto inicial
          const { session, base } = await readBody(req)
          const s = sessions.get(session)
          if (!s) return send(res, 404, { error: 'La tab ya no existe' })
          if (!isLive(s)) return send(res, 400, { error: 'Solo se puede cambiar la base de una tab en vivo' })
          try {
            s.baseline = base ? baselineFromBranch(s.root, s.current, base) : s.snapshot
            s.base = base || null
          } catch (err) {
            return send(res, 400, { error: err.message })
          }
          notify(null)
          return send(res, 200, {})
        }

        if (req.method === 'POST' && url.pathname === '/close') {
          const { session } = await readBody(req)
          closeSession(session)
          notify(null)
          return send(res, 200, {})
        }

        send(res, 404, { error: 'not found' })
      })
    },
  }
}
