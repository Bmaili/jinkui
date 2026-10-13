/**
 * 确认框和输入框（替代 window.confirm / prompt，样式统一）。
 * const ok = await ask({ title, message, ok: '删除', danger: true })
 * const pw = await promptText({ title: '输入主密码', password: true })
 */
import { reactive } from 'vue'

export interface DialogOpts {
  title: string
  message?: string
  ok?: string
  cancel?: string
  danger?: boolean
  /** 有值时显示输入框 */
  input?: { placeholder?: string; password?: boolean; value?: string }
}

export const dialog = reactive({
  open: false,
  opts: { title: '' } as DialogOpts,
  value: '',
  resolve: null as ((v: string | null) => void) | null,
})

function show(opts: DialogOpts): Promise<string | null> {
  dialog.resolve?.(null)
  dialog.opts = opts
  dialog.value = opts.input?.value ?? ''
  dialog.open = true
  return new Promise((r) => (dialog.resolve = r))
}

export function closeDialog(v: string | null) {
  const r = dialog.resolve
  dialog.resolve = null
  dialog.open = false
  r?.(v)
}

export async function ask(opts: Omit<DialogOpts, 'input'>): Promise<boolean> {
  return (await show(opts)) !== null
}

export function promptText(opts: DialogOpts & { input: NonNullable<DialogOpts['input']> }): Promise<string | null> {
  return show(opts)
}
