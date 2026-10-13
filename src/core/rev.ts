/**
 * 条目版本号（混合逻辑时钟，规格 4.3）。
 *
 * 版本号 = (毫秒时间 t, 计数 c, 设备ID d)，按 t → c → d 比较，全序。
 * 新版本号总是大于本机见过的所有版本号：取 max(当前时间, 已见最大 t)，时间没往前走就把计数加一。
 * 这样即使某台手机时钟慢了，它的新修改也一定盖过它已经同步到的旧修改；
 * 只有两台设备在互相看不到的情况下各改各的，才按时间先后（再按设备ID）决出胜负，输的一方进历史。
 */

export interface Rev {
  /** 毫秒时间戳（可能比真实时间大：见过“来自未来”的版本时会跟着走） */
  t: number
  /** 同一毫秒内的计数 */
  c: number
  /** 设备ID */
  d: string
}

export function compareRev(a: Rev, b: Rev): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1
  if (a.c !== b.c) return a.c < b.c ? -1 : 1
  if (a.d !== b.d) return a.d < b.d ? -1 : 1
  return 0
}

export const revEq = (a: Rev, b: Rev) => compareRev(a, b) === 0

export function maxRev(revs: Iterable<Rev>): Rev | null {
  let m: Rev | null = null
  for (const r of revs) if (!m || compareRev(r, m) > 0) m = r
  return m
}

/** 比 seen 里所有版本号都大的新版本号 */
export function nextRev(seen: Rev | null, device: string, now: number = Date.now()): Rev {
  if (!seen || now > seen.t) return { t: now, c: 0, d: device }
  return { t: seen.t, c: seen.c + 1, d: device }
}

export function isRev(x: unknown): x is Rev {
  const r = x as Rev
  return !!r && typeof r === 'object' && Number.isSafeInteger(r.t) && Number.isSafeInteger(r.c) && r.c >= 0 && typeof r.d === 'string' && r.d.length > 0
}

/** 历史去重、排序用的键 */
export const revKey = (r: Rev) => `${r.t}.${r.c}.${r.d}`
