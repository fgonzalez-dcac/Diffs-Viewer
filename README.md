# Diffs Viewer

Observa una o más carpetas **en vivo** y muestra el código viejo y el nuevo lado a lado, con la estructura de carpetas resultante. Sirve para seguir en tiempo real lo que cambia mientras editás, o lo que cambia un agente o un script. También sirve para revisar una branch como si fuera un PR, sin salir de tu máquina.

## ¿Por qué usarlo?

Comparado con la vista de cambios de VS Code, la de un IDE con agente o el chat con Claude:

- **Compara contra una foto, no contra el último commit.** Toma cómo estaba la carpeta al abrirla. Si ya tenías cambios sin commitear y le pedís algo a un agente, ves solo lo que hizo él. Con "Aceptar cambios" marcás un nuevo punto de partida.
- **No le importa quién hizo el cambio.** Observa el disco: vos, Claude Code, otro agente, un script o un `git pull`. La vista de un agente solo muestra lo que editó ese agente.
- **Varias branches y worktrees a la vez.** Cada worktree es una tab en vivo, ideal para varios agentes trabajando en paralelo. Al cambiar de branch, la anterior queda congelada con sus cambios en vez de desaparecer.
- **Muestra lo mismo que un PR, sin subir nada.** Compara contra el merge-base con otra branch e incluye lo que todavía no commiteaste. En GitHub solo ves lo pusheado, y en VS Code necesitás extensiones.
- **Te dice si algo es nuevo o ya existía.** "Find all references" te dice dónde se usa un símbolo. Esta herramienta además te dice si ese uso, o la definición misma, lo trajo este cambio. Sirve para revisar código de un agente: "¿esta función la creó él o ya estaba?".
- **Árbol de la estructura resultante.** Ves qué se creó, se modificó o se borró dentro de su carpeta, en lugar de una lista plana.
- **Liviana y aparte del editor.** Es una pestaña del navegador: la podés tener en otro monitor mientras un agente trabaja solo en la terminal.

**Lo que no hace** (para eso seguí usando las otras herramientas):

- No edita ni permite aceptar o rechazar un cambio puntual: es solo de lectura.
- El estado vive en memoria: si reiniciás el server, la foto inicial se vuelve a sacar.

**En resumen:** no reemplaza al editor ni al PR. Sirve para **supervisar en vivo** los cambios que hace otro, sobre todo un agente, en varias branches a la vez, separando lo nuevo de lo que ya existía.

## Requisitos

- Node.js 20.19+ o 22.12+ (lo piden Vite y chokidar)
- `git`, para las funciones de branches y worktrees (opcional: sin git igual funciona como visor de cambios de una carpeta)
- Para el botón "📂 Explorar…": `zenity` o `kdialog` en Linux (en macOS usa el Finder)

## Instalación y uso

```bash
npm install
npm run dev                          # abre la UI y elegís la carpeta ahí
WATCH_DIR=~/mi-proyecto npm run dev  # o arrancás ya observando una carpeta
npx vite --port 5175                 # en otro puerto, si el 5173 está ocupado
```

Las carpetas abiertas quedan en la URL (`?dir=...&dir=...&active=...`), así que sobreviven a un refresh y podés guardar el link.

## Funcionalidades

### Diff en vivo
- **Código viejo**: por defecto es cómo estaba la carpeta cuando empezaste a observarla (la "Foto inicial"). **Código nuevo** es lo que hay en disco en este momento.
- El diff se ve lado a lado, con resaltado por palabra. Los bloques largos sin cambios se pliegan (click para expandirlos).
- El árbol de la izquierda muestra la estructura resultante: `+` nuevo, `~` modificado, `−` eliminado. Los archivos que se acaban de tocar se iluminan un instante.
- **Solo cambios**: esconde los archivos que no cambiaron.
- **Ancho del árbol**: arrastrá la barra entre el árbol y el diff para agrandarlo (o, con el foco en la barra, `←`/`→`; con `Shift` avanza más). Se recuerda para la próxima vez; doble click vuelve al ancho original.
- **Aceptar cambios**: el estado actual pasa a ser el nuevo "código viejo" (solo en la tab activa).

### Elegir carpetas
- El campo autocompleta rutas mientras escribís: `Tab` completa y entra en la carpeta, `↑↓` elige, `Enter` la agrega. Los repos git aparecen primero, marcados con `⎇`. Con el campo vacío, muestra las carpetas que usaste hace poco.
- **📂 Explorar…** abre el selector de carpetas del sistema.
- Podés sumar varias carpetas: cada una es una tab más.

### Branches
- **Tabs por branch**: cada tab es una carpeta + una branch. Al hacer `git checkout`, desde la app o desde la terminal, la tab de la branch anterior queda congelada con sus cambios y se abre (o se reanuda) la de la branch nueva. `Alt+1..9` salta entre tabs.
- **Branch**: te cambia de branch desde la app (`git switch` en la carpeta de la tab). Si elegís una remota que no tiene branch local, la crea siguiendo a la remota. No hace stash: si git se niega por cambios sin commitear, te muestra el error.
- **Comparar contra**: compara la tab contra el merge-base con otra branch, igual que un PR. Ves lo commiteado y lo que todavía no commiteaste, sin lo que entró después en la otra branch.
- Los dos selectores tienen buscador: filtra por varias palabras en cualquier orden (ej. `origen fondo`), `↑↓` + `Enter` para elegir, `Esc` para cerrar. La lista de branches se pide a git cada vez que lo abrís.
- **Worktrees**: si la carpeta es un repo, sus otros `git worktree` aparecen como tabs punteadas (`+ ⎇ branch`). Con un click los sumás y ves todos en vivo a la vez. Si un worktree está dentro de la carpeta (ej. `.worktrees/`), sus cambios no se mezclan con los del repo principal.

### Buscar funciones y constantes
Está arriba del árbol. También se abre con `Ctrl+Shift+F`; si tenés una palabra seleccionada en el diff, la busca directo.

- Busca dónde aparece el símbolo en la tab y lo clasifica:
  - **Nuevo**: no estaba en el código viejo.
  - **Ya existía**: ya estaba en el código viejo.
  - **Eliminado**: solo está en el código viejo.
- También te dice si la definición es nueva, existente o eliminada.
- Cada uso se marca como `+ nuevo`, `existente` o `− eliminado`. Click en uno abre el diff en esa línea.
- Con "Solo cambios" tildado, se ocultan los usos que no cambiaron (menos la definición).
- Busca la palabra entera y distingue mayúsculas. La definición se detecta con patrones comunes (`const`, `function`, `class`, métodos, arrow functions, `def`, `fn`…).

## Cómo funciona

El proyecto es una app de [Vite](https://vite.dev) sin framework.

- **`watcher-plugin.js`**: un plugin de Vite que hace de backend.
  - Observa las carpetas con [chokidar](https://github.com/paulmillr/chokidar) y guarda en memoria la foto de cada archivo.
  - Mira el `HEAD` de git para detectar cambios de branch.
  - Expone una API en `/api/*` (estado, archivos, branches, checkout, búsqueda de símbolos, autocompletado de rutas).
  - Avisa al navegador de cada cambio por el websocket de Vite.
- **`src/main.js`**: la UI. Calcula el diff con [jsdiff](https://github.com/kpdecker/jsdiff) y se repinta cuando llega un aviso.

Se ignoran `node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`, `coverage` y similares. Los archivos binarios o de más de 1 MB no muestran diff. Todo corre en local: los archivos nunca salen de tu máquina.
