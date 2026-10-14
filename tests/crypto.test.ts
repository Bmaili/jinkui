import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VaultCipher, WrongPassphraseError, changePassphrase, checkPassphrase, createKeys, deviceIdOf, devicePath,
  encryptJsonTo, generatePassphrase, unwrapIdentity,
} from '../src/core/crypto'
import { JOIN_PREFIX, makeJoinCode, normalizeJoinCode, readJoinCode } from '../src/core/sync/setup'
import { utf8 } from '../src/core/bytes'
import { PASS, WF } from './helpers'

const hasAge = (() => {
  try {
    execFileSync('age', ['--version'])
    return true
  } catch {
    return false
  }
})()

describe('主密码与密钥', () => {
  it('主密码规则', () => {
    expect(checkPassphrase('short')).toMatch(/至少/)
    expect(checkPassphrase('aaaaaaaaaaaaaa')).toMatch(/太简单/)
    expect(checkPassphrase('123456789012')).toMatch(/纯数字/)
    expect(checkPassphrase('correct-horse-battery')).toBeNull()
    const g = generatePassphrase()
    expect(g).toMatch(/^([a-z2-9]{4}-){4}[a-z2-9]{4}$/)
    expect(checkPassphrase(g)).toBeNull()
  })

  it('建立、解开、密码错误、改密码', async () => {
    const k = await createKeys(PASS, WF)
    expect(k.identity).toMatch(/^AGE-SECRET-KEY-/)
    expect(k.recipient).toMatch(/^age1/)
    expect((await unwrapIdentity(k.wrapped, PASS)).identity).toBe(k.identity)
    await expect(unwrapIdentity(k.wrapped, 'nope-nope-nope')).rejects.toThrow(WrongPassphraseError)
    const k2 = await changePassphrase(k, 'another-passphrase', WF)
    expect(k2.recipient).toBe(k.recipient)
    expect((await unwrapIdentity(k2.wrapped, 'another-passphrase')).identity).toBe(k.identity)
    await expect(unwrapIdentity(k2.wrapped, PASS)).rejects.toThrow(WrongPassphraseError)
    await expect(createKeys('short', WF)).rejects.toThrow()
  })

  it('加解密数据；用别的密钥解不开', async () => {
    const c = new VaultCipher(await createKeys(PASS, WF))
    const enc = await c.encryptJson({ hello: '世界' })
    expect(new TextDecoder().decode(enc)).not.toContain('世界')
    expect(await c.decryptJson(enc)).toEqual({ hello: '世界' })
    const other = new VaultCipher(await createKeys(PASS, WF))
    await expect(other.decrypt(enc)).rejects.toThrow(/解密失败/)
  })

  it('设备文件路径', () => {
    expect(devicePath('abc_1-2')).toBe('devices/abc_1-2.age')
    expect(deviceIdOf('devices/abc_1-2.age')).toBe('abc_1-2')
    expect(deviceIdOf('devices/../x.age')).toBeNull()
    expect(deviceIdOf('keys/info.json')).toBeNull()
  })
})

describe.skipIf(!hasAge)('和 age 命令行互通（不靠 app 也能解开）', () => {
  it('命令行能用主密码解出保险库密钥，再解开数据文件', async () => {
    const k = await createKeys(PASS, WF)
    const dir = mkdtempSync(join(tmpdir(), 'jinkui-age-'))
    writeFileSync(join(dir, 'identity.age'), k.wrapped)
    writeFileSync(join(dir, 'data.age'), await new VaultCipher(k).encrypt(utf8('{"items":{}}')))
    // age 从终端读密码，这里用 AGE_PASSPHRASE 不行（官方不支持），所以只验证身份密钥这一步用库解，
    // 数据文件用命令行解：证明数据格式是标准 age
    writeFileSync(join(dir, 'key.txt'), k.identity + '\n')
    const out = execFileSync('age', ['-d', '-i', join(dir, 'key.txt'), join(dir, 'data.age')]).toString()
    expect(out).toBe('{"items":{}}')
    // 反过来：命令行加密给公钥的文件，app 能解开
    writeFileSync(join(dir, 'plain.txt'), 'from-cli')
    execFileSync('age', ['-r', k.recipient, '-o', join(dir, 'cli.age'), join(dir, 'plain.txt')])
    const back = await new VaultCipher(k).decrypt(readFileSync(join(dir, 'cli.age')))
    expect(new TextDecoder().decode(back)).toBe('from-cli')
  })
})

describe('加入码', () => {
  const cfg = { type: 'github', github: { owner: 'me', repo: 'jinkui-data', token: 'github_pat_test', branch: 'main', prefix: '' } }

  it('用主密码加密同步配置，粘贴时带换行空格也能解开', async () => {
    const code = await makeJoinCode(cfg, PASS, WF)
    expect(code.startsWith(JOIN_PREFIX)).toBe(true)
    expect(code).not.toContain('github_pat_test')
    const pasted = `  ${code.slice(0, 30)}\n${code.slice(30)} \n`
    expect(normalizeJoinCode(pasted)).toBe(code)
    expect(await readJoinCode(pasted, PASS)).toEqual(cfg)
  })

  it('主密码不对、不是加入码、缺了一截都给出明白的错误', async () => {
    const code = await makeJoinCode(cfg, PASS, WF)
    await expect(readJoinCode(code, 'another-password')).rejects.toBeInstanceOf(WrongPassphraseError)
    await expect(readJoinCode('github_pat_test', PASS)).rejects.toThrow('不是金匮的加入码')
    await expect(readJoinCode(code.slice(0, code.length - 20), PASS)).rejects.toThrow()
  })
})

describe('换密钥时同时加密给新旧两把公钥', () => {
  it('任意一把私钥都能解开', async () => {
    const a = await createKeys(PASS, WF)
    const b = await createKeys(PASS + '-b', WF)
    const bytes = await encryptJsonTo([a.recipient, b.recipient], { x: 1 })
    expect(await new VaultCipher(a).decryptJson(bytes)).toEqual({ x: 1 })
    expect(await new VaultCipher(b).decryptJson(bytes)).toEqual({ x: 1 })
  })
})
