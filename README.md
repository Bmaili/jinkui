# 金匮

个人用的安卓密码管理器。密码加密后同步到你自己的 GitHub 私有仓库或阿里云 OSS，多台设备双向同步。

> 刚发布的第一版。刚开始请不要把它当作唯一的存放处：原来存密码的地方先保留着，用一段时间没问题再完全迁过来。

## 设计要点

- **没有服务器**：数据只在你的手机和你自己的云端存储里。
- **全程加密**：本地和云端都只存密文，格式是开放的 [age](https://age-encryption.org)。就算这个 app 不能用了，在电脑上装个 age 也能解开（云端的 `README.md` 写了步骤）。
- **多设备不丢修改**：每台设备只写自己的文件，读取时合并。两台设备同时改了同一条，一个是当前值，另一个在历史版本里，不会被悄悄覆盖。
- **指纹解锁是真加密**：指纹验证通过后，系统安全芯片里的密钥才会解开保险库，不是“认证成功就放行”。
- **离开就上锁**：回到桌面或切到别的 app 就当作退出，再打开要用指纹或主密码（可以在设置里改成过一会儿再锁）。默认禁止截屏。
- **主密码是唯一的钥匙**：忘了主密码、又丢了所有设备，就再也解不开。没有找回功能。

## 安装与使用

1. 在 [Releases](https://github.com/Bmaili/jinkui/releases) 下载最新的 `jinkui-1.0.N.apk`，在手机上打开安装（第一次会询问是否允许安装未知来源的应用）。
2. 准备一个**私有**的 GitHub 仓库（例如 `jinkui-data`，不要用放代码的仓库），生成 Fine-grained Token：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens，只选这个仓库，Repository permissions → Contents 选 Read and write。也可以用阿里云 OSS（RAM 子账号的 AccessKey，只授予这个 Bucket 的权限）。
3. 打开金匮 → 新建保险库 → 填仓库和 Token → 设置主密码（可以让它生成一个，抄在纸上）。
4. 第二台手机：装好后选“加入已有保险库”，填同样的仓库、Token 和主密码。
5. 以后打开 app、回到前台、修改后几秒、切到后台时都会自动同步。

从别的密码管理器搬过来：在原来的工具里导出 CSV（Chrome、Edge、Bitwarden、KeePassXC 都支持），在“设置 → 从 CSV 导入”选那个文件，导完把 CSV 删掉。

升级：设置 → 关于金匮 → 检查更新，或者在 Releases 下载新版覆盖安装，本机数据不会丢。

## 签名（自己打包时）

推送到 `release` 分支（或推送 `v1.0.N` 形式的 tag）时，GitHub Actions 会签名打包并发布到 Releases。需要在仓库 Settings → Secrets and variables → Actions 里添加 4 个 secret：

| 名称 | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 签名文件的 base64（`base64 -w0 jinkui-release.jks`） |
| `ANDROID_KEYSTORE_PASSWORD` | 签名文件密码 |
| `ANDROID_KEY_ALIAS` | 别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

签名文件可以这样生成：`keytool -genkeypair -keystore jinkui-release.jks -alias jinkui -keyalg RSA -keysize 2048 -validity 36500`。**签名文件和密码务必另外备份**：签名丢了，新版本就不能覆盖安装，只能卸载重装，而卸载会删掉本机数据。

## 开发

```bash
npm install
npm test                 # 单元测试
npm run typecheck        # 类型检查
npm run dev              # 浏览器里预览（数据存在浏览器的 IndexedDB，只用于试用）
npm run build && PLAYWRIGHT_BROWSERS_PATH=<浏览器目录> npm run e2e   # 端到端测试，截图在 e2e/out/
bash e2e/native/compile.sh   # 没有安卓 SDK 时检查原生代码能否编译
```

需求与技术规格见 [SPEC.md](SPEC.md)，给 AI 的项目说明见 [CLAUDE.md](CLAUDE.md)。全部代码由 AI 编写。

## 致谢

- [age](https://age-encryption.org)（[typage](https://github.com/FiloSottile/typage)）：加密
- [Capacitor](https://capacitorjs.com)、[Vue](https://vuejs.org)
- [浮生记](https://github.com/Bmaili/diary-app)：同步后端、应用内更新、发版流程

## 许可

MIT
