/**
 * 诊断记录（规格 6.5）：记下前后台切换、上锁、自动填充每一步发生了什么，方便用户截图反馈问题。
 * 只记事件和 app 包名、网址域名这类信息，绝不记账号、密码、条目内容。最多保留 120 行，存在 Preferences。
 */
import { Preferences } from '@capacitor/preferences'

const KEY = 'jinkui.diag.v1'
const MAX = 120
let lines: string[] | null = null
let timer: ReturnType<typeof setTimeout> | undefined

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
function stamp(d = new Date()) {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

async function load(): Promise<string[]> {
  if (lines) return lines
  try {
    const raw = (await Preferences.get({ key: KEY })).value
    lines = raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    lines = []
  }
  return lines
}

/** 记一行。where 是来源（主界面 / 填充窗口） */
export function diag(msg: string): void {
  const line = `${stamp()} ${msg}`
  void load().then((l) => {
    l.push(line)
    if (l.length > MAX) l.splice(0, l.length - MAX)
    clearTimeout(timer)
    timer = setTimeout(() => void Preferences.set({ key: KEY, value: JSON.stringify(l) }).catch(() => {}), 300)
  })
}

export async function diagLines(): Promise<string[]> {
  return [...(await load())]
}

export async function clearDiag(): Promise<void> {
  lines = []
  await Preferences.remove({ key: KEY }).catch(() => {})
}
