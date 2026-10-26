import type { BackendConfig } from '../../src/store'

/** 同步位置的简短说明（和手机上的 backendTitle 一样；不能直接引用 store.ts，它依赖 Capacitor） */
export function backendTitle(cfg: BackendConfig | null): string {
  if (!cfg) return '未开启同步'
  if (cfg.type === 'github') return `GitHub · ${cfg.github.owner}/${cfg.github.repo}`
  return `阿里云 OSS · ${cfg.oss.bucket}/${cfg.oss.prefix || ''}`
}
