/**
 * 本地文件的防损坏写入（规格 6.4）：每个逻辑文件存两个槽位（name.0 / name.1），轮流写。
 * 槽位内容 = "JKS1" + 序号（8 字节）+ sha256(内容)（32 字节）+ 内容。
 * 读时取校验通过、序号最大的槽位；写时写到另一个槽位，所以最新的那份永远不会被写到一半。
 * 不依赖文件系统的 rename 覆盖语义（Capacitor 的实现在不同平台上不一致）。
 */
import { sha256Hex } from './bytes'

export interface RawStore {
  read(path: string): Promise<Uint8Array | null>
  write(path: string, bytes: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
}

const MAGIC = [0x4a, 0x4b, 0x53, 0x31] // JKS1
const HEADER = 4 + 8 + 32

async function pack(seq: number, payload: Uint8Array): Promise<Uint8Array> {
  const out = new Uint8Array(HEADER + payload.length)
  out.set(MAGIC, 0)
  new DataView(out.buffer).setBigUint64(4, BigInt(seq))
  const h = await sha256Hex(payload)
  for (let i = 0; i < 32; i++) out[12 + i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  out.set(payload, HEADER)
  return out
}

async function unpack(b: Uint8Array | null): Promise<{ seq: number; payload: Uint8Array } | null> {
  if (!b || b.length < HEADER || MAGIC.some((m, i) => b[i] !== m)) return null
  const seq = Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(4))
  const payload = b.slice(HEADER)
  const h = await sha256Hex(payload)
  for (let i = 0; i < 32; i++) if (b[12 + i] !== parseInt(h.slice(i * 2, i * 2 + 2), 16)) return null
  return { seq, payload }
}

export class SlotStore {
  /** 每个文件最近一次读到的最新序号 */
  private seqs = new Map<string, number>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private raw: RawStore) {}

  private async latest(name: string): Promise<{ seq: number; payload: Uint8Array } | null> {
    const [a, b] = await Promise.all([this.raw.read(`${name}.0`).then(unpack), this.raw.read(`${name}.1`).then(unpack)])
    const best = !a ? b : !b ? a : a.seq >= b.seq ? a : b
    this.seqs.set(name, best?.seq ?? 0)
    return best
  }

  async read(name: string): Promise<Uint8Array | null> {
    await this.queue.catch(() => {})
    return (await this.latest(name))?.payload ?? null
  }

  /** 写入；同一个 SlotStore 的写入按顺序执行 */
  write(name: string, payload: Uint8Array): Promise<void> {
    const job = this.queue.catch(() => {}).then(async () => {
      // 每次写之前重新读：自动填充窗口和主界面是两个独立的网页环境，可能都写过这个文件，
      // 用缓存的序号会把对方刚写的那个槽位覆盖掉
      await this.latest(name)
      const seq = this.seqs.get(name)! + 1
      await this.raw.write(`${name}.${seq % 2}`, await pack(seq, payload))
      this.seqs.set(name, seq)
    })
    this.queue = job
    return job
  }

  remove(name: string): Promise<void> {
    const job = this.queue.catch(() => {}).then(async () => {
      await this.raw.remove(`${name}.0`).catch(() => {})
      await this.raw.remove(`${name}.1`).catch(() => {})
      this.seqs.delete(name)
    })
    this.queue = job
    return job
  }
}
