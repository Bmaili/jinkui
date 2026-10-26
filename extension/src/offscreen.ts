/**
 * 看不见的 offscreen 页面：后台没有页面，不能直接用剪贴板。复制在这里做，到时间后
 * 如果剪贴板里还是我们复制的内容（只比较哈希）就清空，然后通知后台关掉这个页面。
 */
import { sha256Hex } from '../../src/core/bytes'
import type { OffscreenMsg } from './messages'

/** 在 copy / paste 事件里读写剪贴板（offscreen 页面没有焦点，navigator.clipboard 用不了） */
function write(text: string) {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', text)
    e.preventDefault()
  }
  document.addEventListener('copy', onCopy)
  try {
    document.execCommand('copy')
  } finally {
    document.removeEventListener('copy', onCopy)
  }
}

function read(): string {
  let got = ''
  const onPaste = (e: ClipboardEvent) => {
    got = e.clipboardData?.getData('text/plain') ?? ''
    e.preventDefault()
  }
  document.addEventListener('paste', onPaste)
  try {
    document.execCommand('paste')
  } finally {
    document.removeEventListener('paste', onPaste)
  }
  return got
}

let timer: ReturnType<typeof setTimeout> | undefined
let ours = ''

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const m = msg as OffscreenMsg
  if (m?.target !== 'offscreen' || m.t !== 'clip') return false
  void (async () => {
    clearTimeout(timer)
    write(m.text)
    if (!m.clearAfterSec) {
      ours = ''
      sendResponse({})
      void chrome.runtime.sendMessage({ t: 'clipDone' }).catch(() => {})
      return
    }
    ours = await sha256Hex(m.text)
    sendResponse({})
    timer = setTimeout(async () => {
      if (ours && (await sha256Hex(read())) === ours) write('')
      ours = ''
      void chrome.runtime.sendMessage({ t: 'clipDone' }).catch(() => {})
    }, m.clearAfterSec * 1000)
  })()
  return true
})
