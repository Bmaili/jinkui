/**
 * 把选好的图片缩成存进保险库的小图标（规格 4.6）：ICON_SIZE 见方，优先 WebP，太大再降质量。
 * - fill：铺满（裁掉多出来的边），用于 app 图标和相册里的图片
 * - pad：白底、居中留边，用于网站的小 favicon（和列表里网站图标的样子一样）
 */
import { ICON_SIZE, MAX_ICON_DATA, isIconData } from '../core/itemIcons'

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片打不开，换一张试试'))
    img.src = src
  })
}

export async function toItemIcon(src: string, mode: 'fill' | 'pad'): Promise<string> {
  const img = await load(src)
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  if (!w || !h) throw new Error('图片打不开，换一张试试')
  const S = ICON_SIZE
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')
  if (!g) throw new Error('这台设备不能处理图片')
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  if (mode === 'pad') {
    g.fillStyle = '#fff'
    g.fillRect(0, 0, S, S)
    const box = S * 0.68
    const k = Math.min(box / w, box / h)
    g.drawImage(img, (S - w * k) / 2, (S - h * k) / 2, w * k, h * k)
  } else {
    const side = Math.min(w, h)
    g.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, S, S)
  }
  for (const q of [0.86, 0.7, 0.5]) {
    let d = c.toDataURL('image/webp', q)
    // 不支持 WebP 的环境会给 PNG；PNG 太大时换 JPEG（白底的才行，透明的会变黑）
    if (!d.startsWith('data:image/webp') && d.length > MAX_ICON_DATA && mode === 'pad') d = c.toDataURL('image/jpeg', q)
    if (isIconData(d)) return d
  }
  throw new Error('图片处理后还是太大')
}

/** 用户选的图片文件 → 缩好的图标 */
export async function iconFromFile(f: File): Promise<string> {
  if (!f.type.startsWith('image/') || f.type.includes('svg')) throw new Error('请选一张图片（PNG、JPEG、WebP 等）')
  const url = URL.createObjectURL(f)
  try {
    return await toItemIcon(url, 'fill')
  } finally {
    URL.revokeObjectURL(url)
  }
}
