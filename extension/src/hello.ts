/**
 * Windows Hello 试验页（设置里打开）：看这台电脑能不能用 Windows Hello（人脸、指纹、PIN）解锁金匮。
 *
 * 要用的是通行密钥的 PRF 扩展：验证通过后，系统给出一段只有这台电脑、这个通行密钥才算得出来的密钥，
 * 以后可以用它代替主密码解开保险库。这一页只试“能不能拿到”，不碰保险库。
 * 需要 Windows 11 24H2 / 25H2（2026 年 2 月以后的更新）和 Chrome 147 以上，扩展页面里能不能用也要试过才知道。
 */
import '../../src/ui/style.css'

const app = document.getElementById('app')!
app.innerHTML = `
  <div class="page" style="max-width:560px;margin:0 auto;padding-top:32px">
    <h1 style="font-size:22px">Windows Hello 试验</h1>
    <p class="muted" style="line-height:1.8">看这台电脑能不能用 Windows Hello（人脸、指纹或 PIN）代替主密码解锁金匮。不会碰你的保险库。</p>
    <p class="muted small" style="line-height:1.8">试验会在 Windows Hello 里留下一个名为“金匮”的通行密钥：以后真的做这个功能时可以接着用；
    不想要的话，在 Windows 设置 → 帐户 → 通行密钥 里删掉。</p>
    <button class="solid-btn" id="go">开始试验</button>
    <pre id="out" class="note-box mono small" style="white-space:pre-wrap;margin-top:16px;display:none"></pre>
    <button class="text-btn accent" id="copy" style="display:none">复制结果</button>
  </div>`

const out = document.getElementById('out')!
const lines: string[] = []
function log(s: string) {
  lines.push(s)
  out.style.display = 'block'
  out.textContent = lines.join('\n')
}

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

interface PrfResults {
  enabled?: boolean
  results?: { first?: ArrayBuffer }
}

async function run() {
  lines.length = 0
  const uaData = (navigator as unknown as { userAgentData?: { getHighEntropyValues(h: string[]): Promise<Record<string, unknown>> } }).userAgentData
  const hi = await uaData?.getHighEntropyValues(['platformVersion', 'fullVersionList']).catch(() => null)
  log(`浏览器：${navigator.userAgent}`)
  if (hi) log(`系统版本号：${String(hi.platformVersion ?? '')}（Windows 11 的是 13 以上）`)
  log(`页面：${location.origin}`)
  if (!window.PublicKeyCredential) return log('❌ 这个浏览器不支持通行密钥')
  const platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false)
  log(`Windows Hello 可用：${platform ? '是' : '否'}`)
  if (!platform) return log('❌ 这台电脑没有设置 Windows Hello（设置 → 帐户 → 登录选项）')

  const salt = rand(32)
  let credId = localStorage.getItem('helloCredId')
  if (!credId) {
    log('第一步：创建通行密钥（会弹出 Windows Hello）…')
    try {
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: { name: '金匮' },
          user: { id: rand(16), name: 'jinkui', displayName: '金匮' },
          challenge: rand(32),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
          extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
          timeout: 120_000,
        },
      })) as PublicKeyCredential | null
      if (!cred) return log('❌ 没有创建（取消了？）')
      const prf = (cred.getClientExtensionResults() as { prf?: PrfResults }).prf
      log(`创建成功；PRF：${prf?.enabled === true ? '支持' : prf?.enabled === false ? '不支持' : '没有回应'}`)
      if (prf?.enabled === false) return log('❌ 这台电脑的 Windows Hello 不支持 PRF：需要 Windows 11 24H2 / 25H2 打过 2026 年 2 月以后的更新，Chrome 147 以上')
      credId = b64(cred.rawId)
      localStorage.setItem('helloCredId', credId)
    } catch (e) {
      return log(`❌ 创建失败：${(e as Error).name}：${(e as Error).message}`)
    }
  } else {
    log('已经有试验用的通行密钥，直接试第二步')
  }

  log('第二步：用它取一段密钥（会再弹出一次 Windows Hello）…')
  try {
    const a = (await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: 'public-key', id: unb64(credId) }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null
    const first = (a?.getClientExtensionResults() as { prf?: PrfResults } | undefined)?.prf?.results?.first
    if (first && first.byteLength >= 32) log(`✅ 可以用：拿到了 ${first.byteLength} 字节的密钥。把这段结果发给我，下一版就做 Windows Hello 解锁`)
    else log('❌ 验证通过了，但没有拿到密钥（PRF 不可用）')
  } catch (e) {
    log(`❌ 取密钥失败：${(e as Error).name}：${(e as Error).message}`)
    if ((e as Error).name === 'NotAllowedError') localStorage.removeItem('helloCredId')
  }
}

const copyBtn = document.getElementById('copy')!
document.getElementById('go')!.addEventListener('click', () => {
  void run().finally(() => (copyBtn.style.display = 'inline-flex'))
})
copyBtn.addEventListener('click', () => void navigator.clipboard.writeText(lines.join('\n')))
