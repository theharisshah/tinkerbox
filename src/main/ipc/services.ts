/**
 * Single import point for the execution (E1) and integrations (E3) APIs used by the shell, as documented in
 * docs/ARCHITECTURE.md §2.1 / §2.3. Keeping them in one place makes the module boundary explicit.
 */
export {
  cancelRun,
  disposeExecution,
  introspectEnvironment,
  introspectMembers,
  invalidateCaches,
  listLogs,
  projectPanels,
  projectSnippets,
  readLog,
  runCode,
  testConnection
} from '../execution'
export { loadShellPath } from '../env/shellPath'
export { findPhpBinaries, inspectPhpBinary } from '../php/binaries'
export { listHerdSites } from '../php/herd'
export { installSandbox, isSandboxAvailable, sandboxPathSync, sandboxStatus } from '../sandbox'

export { createGist } from '../integrations/gist'
export { editorUrl, openProjectInEditor } from '../integrations/editorLinks'
