import type { EventChannel, InvokeChannel } from '../shared/ipc'

/**
 * Channel allow-lists for the preload bridge. They are runtime arrays (the preload cannot inspect TypeScript
 * types), checked at compile time against InvokeChannels / EventChannels in both directions:
 * - `satisfies readonly InvokeChannel[]` rejects names that are not channels;
 * - the AssertNever aliases below fail to compile when a channel is missing from a list.
 */

export const INVOKE_CHANNELS = [
  'app:info',
  'settings:get',
  'settings:update',
  'settings:reset',
  'connections:list',
  'connections:save',
  'connections:delete',
  'connections:openLocal',
  'connections:test',
  'connections:touch',
  'connections:clearRecents',
  'php:binaries',
  'php:inspect',
  'herd:sites',
  'sandbox:status',
  'sandbox:install',
  'run:start',
  'run:cancel',
  'introspect:environment',
  'introspect:members',
  'project:panels',
  'logs:list',
  'logs:read',
  'snippets:list',
  'snippets:save',
  'snippets:delete',
  'snippets:export',
  'snippets:import',
  'history:list',
  'history:delete',
  'history:clear',
  'session:load',
  'session:save',
  'stats:get',
  'themes:listCustom',
  'themes:create',
  'themes:openFolder',
  'dialog:openDirectory',
  'dialog:openFile',
  'file:open',
  'file:save',
  'file:read',
  'file:watch',
  'file:isDirectory',
  'shell:openExternal',
  'shell:openInEditor',
  'shell:openProjectInEditor',
  'shell:revealInFinder',
  'clipboard:write',
  'window:setTitle',
  'window:toggleFullscreen',
  'cli:install',
  'share:gist'
] as const satisfies readonly InvokeChannel[]

export const EVENT_CHANNELS = [
  'run:progress',
  'menu:command',
  'settings:changed',
  'connections:changed',
  'history:changed',
  'app:openPath',
  'file:opened',
  'file:changed',
  'app:notice',
  'sandbox:progress',
  'theme:osChanged'
] as const satisfies readonly EventChannel[]

/** Compiles only when T is `never`. */
type AssertNever<T extends never> = T

/** Fails to compile when an InvokeChannel is missing from INVOKE_CHANNELS. */
export type MissingInvokeChannels = AssertNever<Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>>
/** Fails to compile when an EventChannel is missing from EVENT_CHANNELS. */
export type MissingEventChannels = AssertNever<Exclude<EventChannel, (typeof EVENT_CHANNELS)[number]>>
