/**
 * 用到的那一小部分 Chrome 扩展接口的类型。不引入 @types/chrome：少一个依赖，也一眼看清扩展用了哪些能力。
 */
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: tabs.Tab
      frameId?: number
      url?: string
      id?: string
    }
    const id: string
    const lastError: { message?: string } | undefined
    function getURL(path: string): string
    function getManifest(): { version: string; name: string }
    function sendMessage<T = unknown>(msg: unknown): Promise<T>
    function getContexts(filter: { contextTypes?: string[]; documentUrls?: string[] }): Promise<unknown[]>
    const onMessage: {
      addListener(cb: (msg: unknown, sender: MessageSender, sendResponse: (r?: unknown) => void) => boolean | void): void
    }
    const onInstalled: { addListener(cb: () => void): void }
    const onStartup: { addListener(cb: () => void): void }
  }
  namespace storage {
    interface Area {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
      clear(): Promise<void>
    }
    const local: Area
    const session: Area & { setAccessLevel(o: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void> }
  }
  namespace tabs {
    interface Tab {
      id?: number
      url?: string
      active?: boolean
      windowId?: number
    }
    function query(q: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>
    function get(id: number): Promise<Tab>
    function create(o: { url: string }): Promise<Tab>
    function sendMessage<T = unknown>(tabId: number, msg: unknown, opts?: { frameId?: number }): Promise<T>
    const onRemoved: { addListener(cb: (tabId: number) => void): void }
  }
  namespace alarms {
    interface Alarm {
      name: string
    }
    function create(name: string, o: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void>
    const onAlarm: { addListener(cb: (a: Alarm) => void): void }
  }
  namespace commands {
    const onCommand: { addListener(cb: (command: string, tab?: tabs.Tab) => void): void }
  }
  namespace action {
    function openPopup(): Promise<void>
    function setBadgeText(o: { text: string; tabId?: number }): Promise<void>
    function setBadgeBackgroundColor(o: { color: string }): Promise<void>
  }
  namespace offscreen {
    function createDocument(o: { url: string; reasons: string[]; justification: string }): Promise<void>
    function closeDocument(): Promise<void>
  }
  namespace webNavigation {
    const onCommitted: { addListener(cb: (d: { tabId: number; frameId: number }) => void): void }
  }
}
