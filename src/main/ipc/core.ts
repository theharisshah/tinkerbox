import { app, dialog, shell, type BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createCustomTheme, listCustomThemes } from '../themes'
import { errorMessage, isPlainObject } from '../store/common'
import { sanitizeConnection } from '../store/connections'
import { parseSnippetExport } from '../store/snippets'
import { writeFileAtomicSync } from '../store/jsonStore'
import type { ShellContext } from './context'
import { isDirectorySync } from './connectionResolver'
import { invalidateCaches, projectSnippets, testConnection } from './services'
import { UserFacingError, type HandlerGroup } from './typed'
import { absPath, connectionIdOrNull, int, nonEmptyStr, obj } from './validate'

const MAX_IMPORT_BYTES = 20 * 1024 * 1024


/**
 * Connection ids still in use by the saved session's tabs or by snippets assigned to a project. Clearing the recent
 * folders keeps these entries (only their `lastUsedAt` goes), so open tabs keep their project.
 */
export function referencedConnectionIds(ctx: Pick<ShellContext, 'session' | 'snippets'>): string[] {
  const ids = new Set<string>()
  for (const tab of ctx.session.load()?.tabs ?? []) if (tab.connectionId) ids.add(tab.connectionId)
  for (const snippet of ctx.snippets.list()) if (snippet.connectionId) ids.add(snippet.connectionId)
  return [...ids]
}

export async function showOpenDialog(win: BrowserWindow | null, options: OpenDialogOptions): Promise<string | null> {
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

export async function showSaveDialog(win: BrowserWindow | null, options: SaveDialogOptions): Promise<string | null> {
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

/** Settings, projects (connections), snippets, history, session, stats and themes. */
export function coreHandlers(ctx: ShellContext) {
  let lastThemeErrors = ''

  return {
    'app:info': () => ctx.appInfo(),

    // Settings ---------------------------------------------------------------------------------------------
    'settings:get': () => ctx.settings.getMasked(),
    'settings:update': (_e, patch) => ctx.settings.update(obj(patch, 'patch')),
    'settings:reset': () => ctx.settings.reset(),

    // Connections ------------------------------------------------------------------------------------------
    'connections:list': () => ctx.connections.list(),
    'connections:save': (_e, connection) => {
      const saved = ctx.connections.save(obj(connection, 'connection'))
      // Path / runtime / PHP binary may have changed: cached introspection is stale.
      invalidateCaches(saved.id)
      return saved
    },
    'connections:delete': (_e, id) => {
      const connectionId = nonEmptyStr(id, 'id', 200)
      ctx.connections.delete(connectionId)
      invalidateCaches(connectionId)
    },
    'connections:openLocal': (_e, path) => {
      const dir = absPath(path)
      if (!isDirectorySync(dir)) throw new UserFacingError(`${dir} is not a directory`)
      const conn = ctx.connections.openLocal(dir)
      ctx.folderOpened(conn.path)
      return conn
    },
    'connections:test': async (_e, connection) => {
      const conn = sanitizeConnection(obj(connection, 'connection'))
      await ctx.envReady
      return testConnection(ctx.exec, conn)
    },
    'connections:touch': (_e, id) => ctx.connections.touch(nonEmptyStr(id, 'id', 200)),
    'connections:clearRecents': () => {
      ctx.connections.clearRecents(referencedConnectionIds(ctx))
      ctx.recentFoldersCleared()
    },

    // Snippets ---------------------------------------------------------------------------------------------
    'snippets:list': async (_e, connectionId) => {
      const user = ctx.snippets.list()
      if (connectionId === undefined) return user
      const id = connectionIdOrNull(connectionId)
      try {
        await ctx.envReady
        return [...user, ...(await projectSnippets(ctx.exec, id))]
      } catch (err) {
        // Project snippets are supplementary (and may need an offline SSH server); never hide the user's own.
        ctx.logger.warn('Could not load project snippets:', errorMessage(err))
        return user
      }
    },
    'snippets:save': (_e, snippet) => {
      const input = obj(snippet, 'snippet')
      if (input.source === 'project') {
        throw new UserFacingError('Project snippets are read-only; edit the file in .tinkerbox/snippets instead.')
      }
      return ctx.snippets.save(input)
    },
    'snippets:delete': (_e, id) => {
      ctx.snippets.delete(nonEmptyStr(id, 'id', 200))
    },
    'snippets:export': async (e) => {
      const file = await showSaveDialog(ctx.windowFor(e.sender), {
        title: 'Export Snippets',
        defaultPath: join(app.getPath('documents'), 'tinkerbox-snippets.json'),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (!file) return null
      writeFileAtomicSync(file, ctx.snippets.exportJson() + '\n', 0o644)
      return file
    },
    'snippets:import': async (e) => {
      const file = await showOpenDialog(ctx.windowFor(e.sender), {
        title: 'Import Snippets',
        properties: ['openFile'],
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (!file) return 0
      const info = await stat(file)
      if (info.size > MAX_IMPORT_BYTES) throw new UserFacingError('The file is larger than 20 MB')
      try {
        return ctx.snippets.importMany(parseSnippetExport(await readFile(file, 'utf8')))
      } catch (err) {
        throw new UserFacingError(`Could not import snippets: ${errorMessage(err)}`)
      }
    },

    // History ----------------------------------------------------------------------------------------------
    'history:list': () => ctx.history.list(),
    'history:delete': (_e, id) => {
      if (ctx.history.delete(nonEmptyStr(id, 'id', 200))) ctx.broadcast('history:changed', undefined)
    },
    'history:clear': () => {
      ctx.history.clear()
      ctx.broadcast('history:changed', undefined)
    },

    // Session & stats --------------------------------------------------------------------------------------
    'session:load': (e) => {
      const state = ctx.session.load()
      // The renderer restores its tabs from this answer; open requests that arrived meanwhile (CLI, Finder,
      // deep links) are delivered right after so they land in new tabs instead of being overwritten.
      ctx.rendererReady(e.sender)
      return state
    },
    'session:save': (_e, state) => {
      ctx.session.save(state)
    },
    'stats:get': (_e, year) => ctx.stats.get(year === undefined || year === null ? undefined : int(year, 'year', 1970, 9999)),

    // Themes ------------------------------------------------------------------------------------------------
    'themes:listCustom': async () => {
      const { themes, errors } = await listCustomThemes(ctx.paths.themes)
      ctx.customThemesChanged(themes)
      const signature = errors.map((er) => `${er.file}:${er.message}`).join('\n')
      if (signature && signature !== lastThemeErrors) {
        ctx.notice(
          'warning',
          errors.length === 1
            ? `Custom theme ${errors[0].file} is invalid: ${errors[0].message}`
            : `${errors.length} custom themes are invalid: ${errors.map((er) => er.file).join(', ')}`
        )
      }
      lastThemeErrors = signature
      return themes
    },
    'themes:create': async (_e, name, base) => {
      if (!isPlainObject(base)) throw new TypeError('base must be a theme object')
      try {
        return await createCustomTheme(ctx.paths.themes, nonEmptyStr(name, 'name', 100), base)
      } catch (err) {
        throw new UserFacingError(`Could not create the theme: ${errorMessage(err)}`)
      }
    },
    'themes:openFolder': async () => {
      await mkdir(ctx.paths.themes, { recursive: true })
      const failure = await shell.openPath(ctx.paths.themes)
      if (failure) throw new UserFacingError(`Could not open ${ctx.paths.themes}: ${failure}`)
    }
  } satisfies HandlerGroup
}

