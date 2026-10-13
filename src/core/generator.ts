/**
 * 密码生成器（规格 5.6）。用 crypto.getRandomValues，按“拒绝采样”取下标，没有取模偏差。
 */

export interface GenOptions {
  length: number
  lower: boolean
  upper: boolean
  digits: boolean
  symbols: boolean
  /** 去掉容易看混的字符：0 O o 1 l I | 等 */
  avoidAmbiguous: boolean
}

export const DEFAULT_GEN: GenOptions = { length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true }

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  // 只用大多数网站都接受的符号
  symbols: '!@#$%^&*-_=+?.',
}
const AMBIGUOUS = new Set('0Oo1lI|'.split(''))

/** 0 ≤ x < n 的均匀随机整数 */
export function randomInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new Error('范围不对')
  const limit = Math.floor(2 ** 32 / n) * n
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % n
  }
}

function pool(s: string, avoid: boolean): string {
  return avoid ? [...s].filter((c) => !AMBIGUOUS.has(c)).join('') : s
}

/** 每种选中的字符至少出现一次（很多网站要求“必须包含数字和符号”） */
export function generatePassword(o: GenOptions = DEFAULT_GEN): string {
  const groups = (['lower', 'upper', 'digits', 'symbols'] as const).filter((k) => o[k]).map((k) => pool(SETS[k], o.avoidAmbiguous))
  if (!groups.length) throw new Error('至少选一种字符')
  const length = Math.max(groups.length, Math.min(128, Math.floor(o.length)))
  const all = groups.join('')
  const chars = groups.map((g) => g[randomInt(g.length)])
  while (chars.length < length) chars.push(all[randomInt(all.length)])
  // 打乱，免得前几位总是固定的字符种类
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

/** 估算熵（位）：按字符集大小粗算，用于显示强弱 */
export function estimateBits(password: string): number {
  if (!password) return 0
  let size = 0
  if (/[a-z]/.test(password)) size += 26
  if (/[A-Z]/.test(password)) size += 26
  if (/\d/.test(password)) size += 10
  if (/[^a-zA-Z\d]/.test(password)) size += 32
  // 重复字符多的打折
  const unique = new Set(password).size
  const effective = Math.min(password.length, unique * 2)
  return Math.round(effective * Math.log2(Math.max(size, 2)))
}

export function strengthLabel(bits: number): { label: string; level: 0 | 1 | 2 | 3 } {
  if (bits < 40) return { label: '弱', level: 0 }
  if (bits < 64) return { label: '一般', level: 1 }
  if (bits < 90) return { label: '强', level: 2 }
  return { label: '很强', level: 3 }
}
