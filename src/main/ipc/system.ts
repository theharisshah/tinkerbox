import { app, clipboard, shell, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { installCli } from '../cli'
import { errorMessage } from '../store/common'
import { expandHome } from '../env/which'
import { openExternalSafely } from '../windows'
import { isDirectorySync } from './connectionResolver'
import type { ShellContext } from './context'
import { localPathForFile } from './editorPaths'
import { MAX_EDITOR_FILE_BYTES, MAX_READ_BYTES, readTextFile, saveTextFile } from './files'
import { showOpenDialog, showSaveDialog } from './core'
import { editorUrl, openProjectInEditor } from './services'
import { UserFacingError, type HandlerGroup } from './typed'
import { absPath, connectionIdOrNull, fileFilters, int, nonEmptyStr, optStr, str } from './validate'

const MAX_SAVE_BYTES = 20 * 1024 * 1024
const PHP_FILTERS = [
  { name: 'PHP Files', extensions: ['php'] },
  { name: 'All Files', extensions: ['*'] }
]

/** Dialog filters for "Save as" based on the suggested file name (output.txt, script.php…). */
function saveFilters(defaultName: string | undefined): Array<{ name: string; extensions: string[] }> {
  const ext = defaultName ? extname(defaultName).slice(1).toLowerCase() : 'php'
  if (!ext || ext === 'php') return PHP_FILTERS
  return [
    { name: `${ext.toUpperCase()} Files`, extensions: [ext] },
    { name: 'All Files', extensions: ['*'] }
  ]
}

/** Dialogs, files, shell integration, clipboard, window title and the CLI helper. */
export function systemHandlers(ctx: ShellContext) {
  const watchedSenders = new WeakSet<WebContents>()

  const projectDirFor = (connectionId: string | null): string => {
    const dir = ctx.exec.resolveConnection(connectionId).path
    if (!dir) throw new UserFacingError('This tab is not attached to a project folder.')
    return dir
  }

  return {
    'dialog:openDirectory': async (e, title) =>
      showOpenDialog(ctx.windowFor(e.sender), {
        title: optStr(title, 'title', 200),
        properties: ['openDirectory', 'createDirectory']
      }),

    'dialog:openFile': async (e, title, filters) =>
      showOpenDialog(ctx.windowFor(e.sender), {
        title: optStr(title, 'title', 200),
        properties: ['openFile', 'showHiddenFiles'],
        filters: fileFilters(filters)
      }),

    'file:open': async (e) => {
      const path = await showOpenDialog(ctx.windowFor(e.sender), {
        title: 'Open PHP File',
        properties: ['openFile'],
        filters: PHP_FILTERS
      })
      if (!path) return null
      return { path, content: await readTextFile(path, MAX_EDITOR_FILE_BYTES) }
    },

    'file:save': async (e, content, path, defaultName) => {
      const text = str(content, 'content', MAX_SAVE_BYTES)
      let target: string | null
      if (path !== undefined && path !== null) {
        target = absPath(path)
      } else {
        const name = optStr(defaultName, 'defaultName', 4096)
        target = await showSaveDialog(ctx.windowFor(e.sender), {
          title: 'Save',
          defaultPath: name && isAbsolute(name) ? name : join(app.getPath('documents'), basename(name || 'untitled.php')),
          filters: saveFilters(name)
        })
      }
      if (!target) return null
      try {
        saveTextFile(target, text)
      } catch (err) {
        if (err instanceof UserFacingError) throw new UserFacingError(`Could not save: ${err.message}`)
        throw new UserFacingError(`Could not save ${target}: ${errorMessage(err)}`)
      }
      ctx.watchers.noteWritten(target, text)
      return target
    },

    'file:read': async (_e, path) => readTextFile(absPath(path), MAX_READ_BYTES),

    // Same check (and ~ expansion) as the run resolution of the Default working directory.
    'file:isDirectory': (_e, path) => {
      const dir = expandHome(str(path, 'path', 4096).trim())
      return dir !== '' && !dir.includes('\0') && isAbsolute(dir) && isDirectorySync(dir)
    },

    'file:watch': async (e, tabId, path) => {
      const tab = nonEmptyStr(tabId, 'tabId', 200)
      const owner = e.sender
      if (path === null || path === undefined) {
        ctx.watchers.unwatch(owner.id, tab)
        return
      }
      const file = absPath(path)
      if (!watchedSenders.has(owner)) {
        watchedSenders.add(owner)
        const id = owner.id
        owner.once('destroyed', () => ctx.watchers.unwatchOwner(id))
        // A reload starts a fresh renderer that re-registers its watches.
        owner.on('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) ctx.watchers.unwatchOwner(id)
        })
      }
      await ctx.watchers.watch(owner.id, tab, file)
    },

    'shell:openExternal': async (_e, url) => {
      const opened = await openExternalSafely(nonEmptyStr(url, 'url', 8192), ctx.logger)
      if (!opened) throw new UserFacingError('Only http(s) and mailto links can be opened.')
    },

    'shell:openInEditor': async (_e, file, line, connectionId) => {
      const raw = nonEmptyStr(file, 'file', 4096)
      const lineNumber = line === undefined || line === null ? undefined : int(line, 'line', 1, 10_000_000)
      let local = raw
      try {
        local = localPathForFile(raw, ctx.exec.resolveConnection(connectionIdOrNull(connectionId)))
      } catch (err) {
        // Deleted project: try the path as-is.
        ctx.logger.warn('openInEditor: ', errorMessage(err))
      }
      if (!isAbsolute(local) || !existsSync(local)) {
        throw new UserFacingError(`${raw} was not found on this computer.`)
      }
      const integration = ctx.settings.get().editorIntegration
      const url = editorUrl(integration, local, lineNumber)
      if (url) {
        await shell.openExternal(url)
        return
      }
      const failure = await shell.openPath(local)
      if (failure) throw new UserFacingError(`Could not open ${local}: ${failure}`)
    },

    'shell:openProjectInEditor': async (_e, connectionId) => {
      const dir = projectDirFor(connectionIdOrNull(connectionId))
      if (!isDirectorySync(dir)) throw new UserFacingError(`${dir} does not exist`)
      await openProjectInEditor(ctx.settings.get().editorIntegration, dir)
    },

    'shell:revealInFinder': (_e, path) => {
      const target = absPath(path)
      if (!existsSync(target)) throw new UserFacingError(`${target} does not exist`)
      shell.showItemInFolder(target)
    },

    'clipboard:write': (_e, text) => clipboard.writeText(str(text, 'text', 50 * 1024 * 1024)),

    'window:setTitle': (e, title) => {
      const win = ctx.windowFor(e.sender)
      if (win && !win.isDestroyed()) win.setTitle(str(title, 'title', 500))
    },

    // Native fullscreen (green button, Window menu) is invisible to the page's Fullscreen API, so toggle it here.
    'window:toggleFullscreen': (e) => {
      const win = ctx.windowFor(e.sender)
      if (!win || win.isDestroyed()) return false
      const next = !win.isFullScreen()
      win.setFullScreen(next)
      return next
    },

    'cli:install': () => installCli(ctx.cliEnvironment())
  } satisfies HandlerGroup
}

