# 给 AI 的项目说明

“金匮”是一个安卓密码管理器（包名 `app.jinkui.local`，尚未发布），全部代码由 AI 编写。需求与技术规格见 `SPEC.md`，用户文档见 `README.md`。和用户交流用中文。

## 协作方式

- 看到用户的方案有明显漏洞、隐含假设或更好的替代方案时，直接指出，不要只顺着补充。
- 汇报简洁：做了什么、需要用户做什么、要在手机上验证什么。
- 不确定、改动大或难以回退的决定先问；明确的小改动直接做。
- 用户很懒：不要加必填项，默认值要合理。
- 仓库是公开的：提交说明、文档、测试数据里不要写个人信息、密钥、真实密码、会话链接（例如 Claude-Session 行）。

## 安全第一（比日记 app 严格得多）

- **不能丢数据**：任何可能导致保险库丢失或无法解开的改动（数据格式、密钥结构、加密参数、包名、签名）都要事先明确提醒用户。
- **合并不能悄悄丢修改**：输掉的版本必须进历史。改 `merge.ts` / `vault.ts` 后，`tests/merge.test.ts` 的随机测试（交换律、结合律、幂等、每个版本都还在）必须全过。
- **不能削弱加密**：不降低 scrypt 强度、不在本地或云端存明文、不把密钥写进日志或错误信息。错误信息里也不能带条目内容。
- **格式冻结**：只能加字段，不能改已有字段的含义；未知字段原样保留。读到更新的格式就拒绝写入。
- **每台设备只写自己的文件**：同步引擎不能改写或删除别的设备的文件。例外只有两个：“移除设备”（先合并之后才删）和“作废图案”（删别的设备的 `keys/unlock/<设备ID>.json`，要输主密码）。
- 依赖要少：每加一个依赖都是供应链风险。加密只用 `age-encryption`。

## 命令

```bash
npm test                     # 单元测试，提交前必须全过
npm run typecheck            # vue-tsc 类型检查（开了 noUnusedLocals/Parameters）
npm run build                # 类型检查 + vite 构建
PLAYWRIGHT_BROWSERS_PATH=<浏览器目录> npm run e2e   # 端到端测试（需先 build），截图在 e2e/out/
bash e2e/native/compile.sh   # 用桩类编译全部原生代码（没有安卓 SDK 时）
bash e2e/native/run.sh       # 应用内更新的原生下载逻辑测试
PLAYWRIGHT_BROWSERS_PATH=<浏览器目录> node design/render.mjs   # 由 design/icon.svg 重新生成图标和启动图
npm run cap:sync             # 构建并同步到 android/
```

测试用很低的 scrypt 强度（`tests/helpers.ts` 的 `WF = 10`），正式是 18。`tests/crypto.test.ts` 在装了 `age` 命令行时会验证互通。
改界面后要看截图（`e2e/out/`），亮色、暗色都看。改了原生代码要跑 `compile.sh`（改 `AppUpdatePlugin.java` 还要跑 `run.sh`），桩类不全时补桩类，最终以 CI 的真实打包为准。

## 发布流程

- 改完代码 → `npm test`、`npm run build` 全过（改了界面再跑 e2e，改了原生代码再跑 compile.sh）→ 提交 → 推送到 `main`。CI（`.github/workflows/android.yml`）跑测试并打包，只检查不发布。
- **发布**：用户要发版时，把要发布的提交推到 `release` 分支（`git push origin main:release`）。CI 取已有最大的 `v1.0.N` 加一，签名打包，打 tag 并发布到 Releases。也可以推送 `v1.0.N` 的 tag，但这个环境的 git 代理不允许推 tag、也不允许用 API 建 tag，所以用 `release` 分支。
- 被发布的那个提交的说明就是 Release 说明：第一行写成用户能看懂的更新内容，`---` 之后的部分 app 里不显示。发布前确认最后一个提交的说明写的是这一版的更新内容。
- 推送后用 `https://api.github.com/repos/Bmaili/jinkui/commits/<sha>/check-runs` 查构建结果，失败时看 `.../check-runs/<id>/annotations`；发布后在 `.../releases` 下载 APK，用 `keytool -printcert -jarfile` 核对签名证书 SHA-256 指纹：`FC:85:0E:0C:7B:5A:5A:5E:95:6A:30:4A:70:1C:2D:95:C9:26:FD:C0:66:B2:33:9D:1C:B6:95:90:4B:4D:A3:5A`。不一致说明签名换了，**不要让用户安装**。
- 签名文件不在仓库里，CI 从 secrets 读取。**绝不能换签名**：换了只能卸载重装，卸载会删掉本机保险库。
- 应用内更新（`updateService.ts`）读 `releases/latest`：tag 必须是 `v1.0.N`，安装包名以 `.apk` 结尾且不带 `unsigned`，要保留 GitHub 给的 `digest`（sha256）。改 workflow 的发布步骤时别破坏这几点。

## 代码结构与规格

见 `SPEC.md` 第 3、4、5 节。改了行为要同步更新 `SPEC.md` 和 `README.md`。

- 界面只通过 `src/store.ts` 改数据；保险库是不可变对象（`shallowRef`），编辑用 `core/vault.ts` 的纯函数生成新状态再 `commit`。
- 本地文件一律经过 `platform/files.ts` 的 `SlotStore`，不要直接用 Filesystem 写保险库。
- 视觉：“铜匮”——宣纸底、宋体，强调色古铜金 `--accent`，成功和开关用铜绿 `--ok`，深色是漆黑底。新界面沿用 `style.css` 的变量和 `.group / .row / .field / .solid-btn` 这些类，不引入新风格。
- 标志只有一个：`design/icon.svg` 的金匣子。桌面图标、启动图由 `render.mjs` 生成，app 里用 `components/Logo.vue`（直接引用这个 SVG），不要再画别的标志。

## 常见的坑

| 坑 | 正确做法 |
| --- | --- |
| Capacitor Filesystem 的 rename 覆盖行为各平台不一致 | 用 SlotStore 双槽写入，不靠 rename |
| CapacitorHttp 的 fetch 补丁会损坏二进制请求体 | 真机上用 `platform/nativeHttp.ts` 直接调插件 |
| scrypt 会卡住界面一两秒 | 先把“正在…”画出来（`requestAnimationFrame` 后再开始），按钮禁用 |
| 端到端测试里 `text=加入`、`text=删除` 会先匹配到标题 | 用 `.actions .solid-btn`、`.dlg .btns >> text=删除` 这类限定在按钮区的选择器 |
| 指纹框是系统界面 | 在浏览器和端到端测试里不可用；`window.__vaultKeyMock` 可以放假的实现 |
| 云端环境没有安卓 SDK，也连不上 Google Maven | 原生代码用 `e2e/native/stubs/` 的桩类编译检查，最终看 CI |
| 自动填充窗口（AutofillActivity）和主界面是两个独立的 WebView，内存各是各的 | 本地写入前先合并磁盘上的（`persistVault`），SlotStore 不缓存序号；主界面回到前台时合并磁盘。不要在内存里“以我为准”整个覆盖 |
| 自动填充的密码不能经过系统进程 | 保存请求的账号密码放在 `PendingSaves`（进程内存），Intent 里只放令牌；填充结果只通过 Dataset 交给系统 |
| 自动填充窗口要能把结果交回系统 | 它不能是 singleTask（主界面是），独立任务 `taskAffinity=""`；填充的 PendingIntent 在安卓 12 起要 `FLAG_MUTABLE`（系统要往里放页面结构） |
| 用 `FillResponse.setAuthentication`（整个响应要验证），窗口却交回 Dataset | 系统当成无效结果悄悄丢掉，“选了账号却没填进去”。验证挂在 Dataset 上（`Dataset.Builder.setAuthentication`，值留空）。桩类故意不提供前者 |
| 交回的 Dataset 用重新解析出来的 AutofillId | 可能和提示里的对不上。用服务放进 Intent 的原样 ID（`EXTRA_USERNAME_ID` / `EXTRA_PASSWORD_ID`） |
| 调起系统界面（选文件、分享、设置弹窗）后靠 focus 事件恢复“离开上锁” | 安卓 WebView 不一定发 focus。用 `expectExternal()`：下一次切后台用掉、回前台作废、会过期 |
| 后台的定时器（Handler、setTimeout） | 安卓 11 起后台 app 会被冻结，定时器不跑。一定要按时做的（清剪贴板）用系统闹钟唤起，回到前台时再补一次 |
| 在后台弹指纹框 | 系统会立刻取消，回来就没有指纹框。只在 `app.active` 时弹，回前台看 `foregroundTick` |
| 真机才出现的问题 | 先看“设置 → 诊断记录”（`diag.ts`、`AutofillLog.java`），缺信息就补记录，不记任何秘密 |
| 原生插件在 `window.__autofillMock` / `__vaultKeyMock` 有假实现 | 端到端测试用它们模拟自动填充窗口和指纹 |
