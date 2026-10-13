/** 界面上的时间与颜色小工具 */

const pad = (n: number) => String(n).padStart(2, '0')

/** “刚刚”“5 分钟前”“今天 14:03”“10 月 3 日”“2025 年 10 月 3 日” */
export function timeAgo(ms: number, now = Date.now()): string {
  if (!ms) return '从未'
  const d = new Date(ms)
  const diff = now - ms
  if (diff < 60_000 && diff > -60_000) return '刚刚'
  if (diff > 0 && diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const n = new Date(now)
  const sameDay = d.toDateString() === n.toDateString()
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const y = new Date(now - 86400_000)
  if (d.toDateString() === y.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 按标题算出一个稳定的头像底色（传统色里挑几种，深浅色模式下都看得清白字） */
const AVATAR = ['#8d6526', '#3f7d6c', '#5b6d80', '#8a4f6a', '#6f7f3a', '#9a5a3a', '#4f5f8f', '#6a5a4a']
export function avatarColor(seed: string): string {
  let h = 0
  for (const c of seed) h = (h * 31 + c.codePointAt(0)!) >>> 0
  return AVATAR[h % AVATAR.length]
}

/** 网址显示成域名 */
export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function openUrl(url: string) {
  const u = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
  if (!/^https?:/i.test(u)) return
  window.open(u, '_blank', 'noopener')
}
