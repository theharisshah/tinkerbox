import type { SandboxStatus } from '../../shared/types'
import type { SandboxLocation } from './connectionResolver'

export interface SandboxManagerDeps {
  /** E1 sandboxStatus(ctx). */
  status(): Promise<SandboxStatus>
  /** E1 installSandbox(ctx, onLine) — serializes concurrent installs itself and reports failures in `error`. */
  install(onLine: (line: string) => void): Promise<SandboxStatus>
  /** E1 isSandboxAvailable(ctx) / sandboxPathSync(ctx): synchronous location for resolveConnection(). */
  locate(): SandboxLocation
  envReady: Promise<void>
}

/** Thin coordinator between the IPC layer and the execution module's sandbox functions. */
export class SandboxManager {
  private last: SandboxStatus | null = null

  constructor(private readonly deps: SandboxManagerDeps) {}

  location(): SandboxLocation {
    return this.deps.locate()
  }

  async refresh(): Promise<SandboxStatus> {
    await this.deps.envReady
    this.last = await this.deps.status()
    return this.last
  }

  /** Install / update; progress lines are forwarded together with an "installing" status. */
  async install(onProgress: (line: string, status: SandboxStatus) => void): Promise<SandboxStatus> {
    await this.deps.envReady
    const location = this.location()
    const progress: SandboxStatus = {
      installed: location.installed,
      path: location.path,
      installing: true,
      ...(this.last?.laravelVersion ? { laravelVersion: this.last.laravelVersion } : {})
    }
    this.last = await this.deps.install((line) => onProgress(line, progress))
    return this.last
  }
}
