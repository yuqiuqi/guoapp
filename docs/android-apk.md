# 用 GitHub Actions 生成并安装一个 Android APK

这个流程只构建 Android，将一个 APK 上传到 Actions 的 Artifacts，保留 14 天，不创建 tag 或 GitHub Release。Android 正式签名密钥可以免费生成，自行安装 APK 不需要购买证书或注册 Google Play 开发者账号。

## 一、先选测试安装还是长期使用

- **先体验：**选择 `test`，无需创建密钥或配置 Secrets。它是 release 模式编译、测试密钥签名的可安装 APK，文件名以 `-test.apk` 结尾。不同次构建的测试密钥可能不同，不保证覆盖已有安装。
- **长期使用：**先按下面步骤生成并保存自己的密钥，再选择 `release`。APK 必须通过你配置的证书指纹核验，文件名以 `-release.apk` 结尾。后续升级继续使用同一密钥。

正式模式缺少配置会明确失败，不会自动退回测试签名。PR 自动构建固定为红果鉴、ARM64、测试签名，不使用正式签名 Secrets。需要其他版本、架构或正式签名时，合并工作流后手动运行。

## 手动打包前自动同步上游

点击 **Run workflow** 后，流程先读取 `Xanerix/guoapp:main` 的最新提交，将该提交普通合并到**当前运行仓库的 `main`**，保留 fork 自有提交。合并成功后，APK job 使用同步步骤返回的确定提交 SHA 检出代码，再安装依赖和构建；不会继续构建触发运行时的旧快照。上游在运行过程中产生的新提交由下一次运行同步。

同步摘要会列出上游 SHA、目标仓库和 APK 使用的 SHA；APK 摘要也会记录代码 SHA，便于核对产物来源。多个同步步骤在同一仓库中串行执行。

- 上游已包含在当前 `main` 时，使用当前 fork 的 `main` 构建，不丢弃自有改动。
- 合并冲突、权限不足或无法确认提交包含上游时，流程报错，APK job 不会启动。请先解决冲突或权限问题后重跑；流程不强推、不重置分支。
- PR 自动构建只验证 PR 的代码，使用只读权限，不同步或写入 `main`。只有手动打包进入自动同步步骤。
- 同步成功但打包失败时，已合并的上游代码仍保留在 `main`，不会回滚仓库。

同步 job 申请 `contents: write`，默认使用 GitHub 自动提供的 `GITHUB_TOKEN`；APK job 保持只读权限。如果仓库或组织限制 Actions 写权限，需要管理员允许该同步 job 写入；如果 `main` 有分支保护，也需要遵守相应规则。

若同步报错提示无法修改 `.github/workflows/` 或内置 token 权限不足，可额外配置 Repository Secret **`UPSTREAM_SYNC_TOKEN`**：

1. 在 GitHub 个人设置 **Settings → Developer settings → Personal access tokens → Fine-grained tokens** 新建 token。
2. Resource owner 选择你自己；Repository access 只选择 `yuqiuqi/guoapp`。
3. Repository permissions 设置 **Contents: Read and write**；同步上游工作流文件还需要 **Workflows: Read and write**。Metadata 保持默认读取。
4. 设置合适的有效期并生成，将值保存到该仓库的 Actions Repository Secret `UPSTREAM_SYNC_TOKEN`。此 token 只提供给手动同步 job，不传给 APK 构建或 PR job。

不要把个人 token 提交到仓库。默认内置 token 已能同步时，无需另外创建 token；分支保护不会因为配置个人 token 就自动失效。

## 二、免费生成正式签名密钥（只做一次）

在**自己的电脑**安装 JDK 17 或更新版本，确认 `keytool -help` 能运行。如果终端找不到 `keytool`，将 JDK 的 `bin` 目录加入 PATH，或使用它的完整路径。

已有相同应用的签名密钥时，应继续使用原密钥，不要重新生成。下面目录均在项目仓库之外，避免误提交密钥。

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\guoapp-signing" | Out-Null
keytool -genkeypair -v -storetype JKS -keystore "$env:USERPROFILE\guoapp-signing\guoapp-release.jks" -alias guoapp -keyalg RSA -keysize 3072 -validity 10000
```

### macOS / Linux

```bash
mkdir -p "$HOME/guoapp-signing"
chmod 700 "$HOME/guoapp-signing"
keytool -genkeypair -v -storetype JKS -keystore "$HOME/guoapp-signing/guoapp-release.jks" -alias guoapp -keyalg RSA -keysize 3072 -validity 10000
chmod 600 "$HOME/guoapp-signing/guoapp-release.jks"
```

按提示完成：

1. 输入签名文件密码，至少 6 个字符，建议使用密码管理器生成的强密码；终端不显示输入字符是正常现象。
2. 填写证书的姓名/组织/地区等信息。证书信息可以被安装包使用者查看，不要填不希望公开的个人信息。
3. 确认信息。若提示输入 `guoapp` 的密钥密码，可以直接回车使用与签名文件相同的密码，也可以设置另一密码。
4. 最后得到 `guoapp-release.jks`，密钥别名是 `guoapp`。

若目标文件已存在，先确认是否为要保留的原密钥，不要覆盖或删除。将 `.jks`、别名和密码分别妥善备份；丢失密钥通常无法再给相同应用提供兼容的覆盖更新。不要把它们提交到 Git、放进 Issue/PR 或发送到聊天。

## 三、生成 Base64 文件并读取证书指纹

Base64 只是编码，**不是加密**。生成的文本文件和 `.jks` 一样需要保密。

### Windows PowerShell

```powershell
[IO.File]::WriteAllText("$env:USERPROFILE\guoapp-signing\keystore-base64.txt", [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\guoapp-signing\guoapp-release.jks")))
keytool -list -v -keystore "$env:USERPROFILE\guoapp-signing\guoapp-release.jks" -alias guoapp
```

### macOS / Linux

```bash
umask 077
base64 < "$HOME/guoapp-signing/guoapp-release.jks" | tr -d '\r\n' > "$HOME/guoapp-signing/keystore-base64.txt"
keytool -list -v -keystore "$HOME/guoapp-signing/guoapp-release.jks" -alias guoapp
```

输入签名文件密码，在输出中找到证书指纹的 `SHA256:` 一行。保留该行冒号后的完整指纹，填写时可保留各字节间的冒号；不要误用 SHA-1 指纹，也不要把整份证书输出填进去。证书指纹是公开校验信息，不是私钥。

## 四、配置 GitHub 仓库

打开**你自己的仓库**，例如 `yuqiuqi/guoapp`，进入 **Settings → Secrets and variables → Actions**。

在 **Secrets → New repository secret** 中分别创建：

| 名称 | 要填写的值 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | 本机 `keystore-base64.txt` 的完整内容；不要上传文件路径 |
| `ANDROID_KEYSTORE_PASSWORD` | 第二节输入的签名文件密码 |
| `ANDROID_KEY_ALIAS` | `guoapp`，或你实际生成密钥时指定的别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码；生成时回车复用密码则与签名文件密码相同 |

切换到 **Variables → New repository variable**，创建：

| 名称 | 要填写的值 |
|---|---|
| `ANDROID_CERT_SHA256` | 第三节读取的完整 SHA-256 指纹 |

以上是 **Repository secrets / variables**，不要误建成某个 Environment 专用的配置；该工作流没有绑定 GitHub Environment。只有仓库管理者能设置这些内容。若仓库已有以上配置且用于同一应用的正式更新，应保留并复用。

配置后可删除不再需要的本地 `keystore-base64.txt`，保留 `.jks` 和密码的可靠备份。GitHub Secrets 不提供取回明文值的功能，不能代替你的密钥备份。

## 五、运行 Actions

1. 合并包含 `.github/workflows/android-apk.yml` 的 PR，使工作流进入默认分支。
2. 打开仓库 **Actions**。如果 fork 的 Actions 尚未启用，先按页面提示启用。
3. 左侧选择 **Build Android APK**，点击 **Run workflow**，选择分支及参数。
4. `edition`：`hongguojian` 为红果鉴，`zhenguojian` 为包含全部站源的真果鉴；每次只选择一个。
5. `abi`：大多数新手机选 `arm64-v8a`，较老的 32 位手机/电视选 `armeabi-v7a`，x86 模拟器选 `x86_64`；每次只选择一个。
6. `signing`：先体验选 `test`；已完成 Secrets 和指纹配置后选 `release`。
7. 点击运行，先等待上游合并到当前仓库 `main`，再等待 APK 构建成功。在该次运行底部 **Artifacts** 下载 `apk-版本-架构-签名模式` 对应的 ZIP。
8. 解压后得到唯一一个 APK。运行摘要还会列出文件名、APK SHA-256、签名证书 SHA-256。

首次构建需要下载 Flutter、Android SDK、NDK 和依赖，耗时取决于 GitHub runner 和网络。出现红色失败时展开失败步骤查看具体原因；失败或正在运行不表示 APK 已生成。Artifact 下载通常需要登录 GitHub。

PR 创建后也会自动构建一个 ARM64 测试 APK；在 PR 的 Checks 中打开 **Build Android APK** 对应运行即可下载，无需先合并。但 fork PR 可能需要仓库维护者批准运行。

## 六、在 Android 手机上安装与更新

1. 将解压出的 `.apk` 下载或传到手机，用文件管理器打开。
2. 系统提示时，允许**当前用于打开 APK 的浏览器或文件管理器**“安装未知应用”，再确认安装。安装完成后可关闭该来源的权限。
3. 正常更新使用相同版本类型（红果鉴/真果鉴）、相同签名的新版 APK 覆盖安装，并保持构建号递增。

常见提示：

- **与现有应用签名不一致 / 安装包冲突：**可能混用了测试签名、他人发布签名或不同密钥。优先找回原签名。必须卸载重装时，先从应用导出备份；卸载会清除应用数据，也可能清除应用专属下载文件。
- **不支持该设备 / NO_MATCHING_ABIS：**重新选择匹配手机 CPU 的 ABI 构建。
- **版本较低：**Android 通常拒绝低构建号覆盖高构建号，构建新版本时同步提高 `pubspec.yaml` 的版本号和 `+` 后构建号。
- **正式构建缺少 Secret：**按第四节核对名称、Repository 范围与密码；不要把秘密贴进日志求助。
- **证书指纹不一致：**核对是否把另一把密钥的指纹填入变量，或误填 SHA-1。

## 签名文件的处理范围

正式密钥只在选用 `release` 的手动构建中从 Secrets 读取，临时还原到 runner 的临时目录，结束后清理。上传路径仅匹配 `dist/android/*.apk`，不会上传签名文件、密码或 Base64 文本。只有手动同步 job 拥有 `contents: write`；检查和 APK job 使用 `contents: read`，不自动生成新密钥、不把密钥写回仓库、不创建 Release。
