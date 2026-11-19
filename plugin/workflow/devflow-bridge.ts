// dsh-kanban-devflow: optional sync-bridge loader (fork addition; kept in its own file to ease merges from upstream).
//
// The "dev delivery" kit ships a sync bridge (bridge/kanban-bridge.mjs) that keeps Workflow tasks and kanban cards
// in step. It lives in the kit checkout, not in this package, so `git pull` on the kit takes effect after a DSH restart.
// install.mjs records where it is in <profile>/dsh-devflow-bridge.json: { "bridge": "<absolute path to kanban-bridge.mjs>" }.
// No file → plain kanban plugin. A broken bridge never prevents the plugin from loading.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const BRIDGE_CONFIG_FILE = 'dsh-devflow-bridge.json'

export interface DevflowBridge {
  poke(): void
  dispose(): void
}

export function readBridgeConfig(profileDir: string): { bridge: string } | null {
  const file = join(profileDir, BRIDGE_CONFIG_FILE)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed.bridge === 'string' && parsed.bridge ? { bridge: parsed.bridge } : null
  } catch {
    return null
  }
}

export async function startDevflowBridge(deps: {
  core: unknown
  store: unknown
  attachments: unknown
  workspaceRegistry: unknown
  readArtifactText: unknown
  profileDir: string
}): Promise<DevflowBridge | undefined> {
  const config = readBridgeConfig(deps.profileDir)
  if (!config) return undefined
  try {
    if (!existsSync(config.bridge)) throw new Error('bridge file not found: ' + config.bridge)
    // ?t= defeats the module cache so a kit update is picked up when the plugin reloads.
    const { startBridge } = await import(pathToFileURL(config.bridge).href + '?t=' + Date.now())
    return startBridge(deps)
  } catch (error) {
    console.warn('kanban-bridge: not started', (error as Error)?.message ?? error)
    return undefined
  }
}
