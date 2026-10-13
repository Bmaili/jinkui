/**
 * 云端存储的统一接口（规格 7.1）。路径相对于保险库根目录，例如 devices/abc.age。
 *
 * version 是云端给出的版本标识（GitHub 是 blob sha，OSS 是 ETag），只用来判断“变没变”，不比较大小。
 */
import { http, NetworkError, type HttpRequest, type HttpResponse } from '../http'

/** 发请求；网络错误统一转成可重试的 RemoteError */
export async function call(req: HttpRequest): Promise<HttpResponse> {
  try {
    return await http(req)
  } catch (e) {
    if (e instanceof NetworkError) throw new RemoteError(e.message)
    throw e
  }
}

export interface RemoteFile {
  path: string
  version: string
  size: number
}

export interface PutOpts {
  /**
   * null：只能新建，已存在就抛 RemoteConflictError。
   * 字符串：云端当前是这个版本才覆盖，否则抛 RemoteConflictError（后端做不到时可以忽略，见各实现的说明）。
   * 不给：直接覆盖。
   */
  ifVersion?: string | null
}

export interface RemoteStore {
  readonly id: string
  readonly label: string
  /** 列出全部文件 */
  list(): Promise<RemoteFile[]>
  /** 下载一个文件，不存在时返回 null */
  get(path: string): Promise<Uint8Array | null>
  /** 上传，返回新版本标识 */
  put(path: string, bytes: Uint8Array, opts?: PutOpts): Promise<string>
  /** 删除；不存在时不报错 */
  remove(path: string): Promise<void>
  /** 检查配置：能否访问、权限够不够。不写任何文件 */
  test?(): Promise<void>
  /** 凭据（GitHub Token）的过期时间，毫秒；不会过期或不知道时为 0 或不提供 */
  readonly credentialExpiry?: number
}

export class RemoteError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = true) {
    super(message)
  }
}

/** 条件写入失败：别人先改了这个文件 */
export class RemoteConflictError extends RemoteError {
  constructor(path: string) {
    super(`云端文件已被改动：${path}`, 409, true)
  }
}

/** 内存里的云端，测试和浏览器预览用 */
export class MemoryRemote implements RemoteStore {
  readonly files = new Map<string, { bytes: Uint8Array; version: string }>()
  private counter = 0
  /** 测试用：在某个操作前抛错，模拟断网 */
  failOn: ((op: 'list' | 'get' | 'put' | 'remove', path?: string) => Error | null) | null = null
  /** 测试用：每次请求的记录 */
  readonly calls: string[] = []

  constructor(readonly id = 'memory', readonly label = '内存') {}

  private check(op: 'list' | 'get' | 'put' | 'remove', path?: string) {
    this.calls.push(path ? `${op} ${path}` : op)
    const e = this.failOn?.(op, path)
    if (e) throw e
  }

  async list(): Promise<RemoteFile[]> {
    this.check('list')
    return [...this.files].map(([path, f]) => ({ path, version: f.version, size: f.bytes.length })).sort((a, b) => a.path.localeCompare(b.path))
  }

  async get(path: string): Promise<Uint8Array | null> {
    this.check('get', path)
    const f = this.files.get(path)
    return f ? f.bytes.slice() : null
  }

  async put(path: string, bytes: Uint8Array, opts: PutOpts = {}): Promise<string> {
    this.check('put', path)
    const cur = this.files.get(path)
    if (opts.ifVersion === null && cur) throw new RemoteConflictError(path)
    if (typeof opts.ifVersion === 'string' && cur?.version !== opts.ifVersion) throw new RemoteConflictError(path)
    const version = `v${++this.counter}`
    this.files.set(path, { bytes: bytes.slice(), version })
    return version
  }

  async remove(path: string): Promise<void> {
    this.check('remove', path)
    this.files.delete(path)
  }
}
