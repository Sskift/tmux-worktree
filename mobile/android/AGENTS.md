# Android / APK Agent 约束

本文件适用于 `mobile/android/**`，补充仓库根目录的 `AGENTS.md`。进入本目录后仍需先阅读根规则；若两者冲突，以更严格的安全、兼容和测试准入要求为准。

## 当前实现边界

- 这里交付原生 Kotlin + Compose Android 客户端。`V2Activity` / `V2ViewModel` 表示第二代 Android 产品与客户端架构，不表示 Relay v2。
- 没有已存在且 cold-start credential/admission 验证成功的显式 v2 profile 时，生产连接仍由 `RelayV1ConnectionActor` 和 `core/relay/v1` codec 驱动。Relay v1 contract 是 active-but-legacy-frozen；不得在 Android 单端添加 wire 字段或从终端文本伪造 Agent 回复、transcript、Waiting/Failed/Completed 状态。
- 只有上述显式 v2 profile 才进入受限的 `RelayV2BaseRuntimeComposition`：它已装配独立 v2 actor、bounded WSS、Room 基础 state-sync、Outbox query/recovered 与 bounded fresh durable dispatch、受限 Session reply producer，以及 default-off 的 selected-Session structured transcript/lifecycle evidence 投影 seam。`core/relay/v2/codec` 仍是与 Node 独立实现、共同消费 `contracts/relay/v2` 的 strict conformance 边界；production actor 的 `optionalCapabilities` 仍固定为空，所以 selected-Session seam 当前只返回 `Unavailable` 空页，真实 Agent reply/state/capability、通知和完整 extension runtime 仍未交付。Dashboard、`relay-server` 和 `relay-host` 的 production runtime 仍只实现 Relay v1；上述 Android seam 不得被宣称为完整 Relay v2、ready 或 capability 已交付，也不得在失败时 fallback 到 v1。
- Compose 只通过 `V2ViewModel` 进入 repository/actor；Room、DataStore、Keystore 和 WebSocket 不得成为 Screen 的直接依赖。
- `MainActivity`、`LegacyIdentityImporter`、`TerminalWebView`、xterm assets 和 v1 actor 都仍是生产或升级兼容路径，不得因名称像 legacy 就删除。

## 验证原则

默认运行能覆盖本次风险的最小检查。**不要因为修改位于 APK、准备交付、希望“保险”，或某个 aggregate gate 当前可用，就自动运行所有 Android、全仓或设备测试。**

以下命令均从仓库根目录运行；本机没有 SDK 配置时先设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT`。

### 默认：直接相关测试

纯 Kotlin 规则、parser、reducer、planner、registry、codec 或 actor 的局部修改，先运行最近的 JVM 测试类：

```bash
./mobile/android/gradlew -p mobile/android \
  :app:testDebugUnitTest \
  --tests 'com.tmuxworktree.mobile.core.relay.runtime.RelayConnectionReducerTest'
```

- 修复失败时只重跑失败类或直接相关类；不要为了一个失败 case 反复跑 `verify:android`。
- 测试代码自身的局部修改默认只运行被修改的测试类。
- 仅 Markdown 变更只运行 `sh scripts/verify.sh docs`。
- 若改动没有新的独立故障风险，运行现有相关测试即可；不要为了 diff 对称或测试数量新增 case。

### 按风险追加检查

| 改动 | 默认追加证据 |
| --- | --- |
| Compose Screen、导航或无障碍交互 | 最近的 Compose/instrumented case；需要设备时按类过滤 `:app:connectedDebugAndroidTest`，不要先跑全仓 |
| Android resource、manifest、network security、backup policy | 对应 packaging/manifest test + 受影响 variant 的 `:app:lintDebug` 或 `:app:lintRelease` |
| Debug APK 打包或依赖内容 | `:app:assembleDebug`；只有 Release 产物也受影响时才追加 `:app:assembleRelease` |
| Release-only 分支、WSS/cleartext policy、版本或发布配置 | `:app:lintRelease :app:assembleRelease`，并运行直接相关行为测试 |
| Room DAO/repository、DataStore、Keystore、Intent/Activity 生命周期 | 最近的 JVM 或 instrumented authority-boundary case；只有真实 Android framework 行为改变时才要求 connected test |
| Relay v1 codec，但共享 fixture 未改变 | Android 直接相关 codec/actor test；不要自动跑 Node、Dashboard 或 Rust |
| `contracts/relay/v1` 或 `contracts/relay/v2` fixture、跨 Node/Android wire 行为 | 两端最小 contract/codec consumer test；只有 fixture/manifest 或多消费者共享行为变化才在收敛后追加一次 `npm run verify:all` |

connected test 按类过滤时使用 Android instrumentation runner 参数，例如：

```bash
./mobile/android/gradlew -p mobile/android \
  :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.tmuxworktree.mobile.core.data.TwRepositoryInstrumentedTest
```

没有 emulator/device、且本次风险不依赖 Android framework 时，不得把缺少 connected test 描述为实现阻塞；应明确记录未运行的设备证据。

## Aggregate gate 的封闭触发条件

`npm run verify:android` 是 Android 层完整无设备门禁（JVM、Debug/Release Lint、Debug/Release build、docs），不是日常默认命令。仅在以下任一条件成立时运行：

1. Room schema/migration、manifest/packaging、依赖或版本配置改变；
2. 共享 actor、repository、credential/profile 切换或多个 Android feature 同时受影响，无法由少量测试类封闭风险；
3. 广泛 Compose/navigation 改动影响多个核心流程；
4. 准备 Android release candidate，或用户明确要求 Android 全量验证；
5. 最小检查暴露跨层影响，且相关风险无法再收窄。

只有修改共享 RPC/wire/storage contract 或确实跨 CLI/Dashboard/Rust/Android consumer 时，才运行 `npm run verify:all`。Android 单端实现、样式、文案、普通 Room/UI 修改不得触发全仓 gate。

只有真实设备行为、升级安装、相机/QR、WebView/IME、Android Keystore、系统权限、后台/网络切换或 release device 验收在范围内时，才运行 `npm run verify:device`。纯 JVM、文档、codec、fake transport 或无设备 UI 状态修改不得触发 device gate。

同一轮工作遵循：相关 case → 受影响层 → 必要时一次 aggregate gate。aggregate 失败后先重跑失败 task 和直接相关 case；不要每次修复后重新跑全套。

## 测试维护

- 新测试必须保护可观察行为、版本化 contract、关键状态转换，或真实发生过的安全/生命周期缺陷；修改前应能因正确原因失败。
- 优先扩展最近的测试文件和 table case。不要为任务阶段、文件拆分、函数名、调用次数、Compose 结构、依赖字面量或源码形状新增测试。
- Android 与 Node 各自消费同一共享 Relay fixture 是跨端互操作证据，不算重复；Android 内部再维护一套等价 inline golden 则应合并。
- manifest、backup、network security 和 APK 内容可以做窄 packaging 检查；不要读取 `build.gradle.kts` 或 Kotlin 源码文本来冻结具体依赖版本、类名或实现路径。优先检查 resolved dependency、merged manifest、编译结果或实际 artifact。
- actor 并发/背压/epoch、Outbox `AMBIGUOUS`、profile disconnect barrier、credential migration、Intent secret 清理和 stream ownership 属于独立高风险边界，不得仅为减少数量删除。

## 交付证据

交付说明必须列出实际运行的命令及其覆盖风险，并明确区分：

- JVM/contract 行为已验证；
- Lint/编译/APK 打包已验证；
- emulator/device 是否运行；
- 签名、升级安装、真实 WSS/Relay 和渠道发布是否仍未验证。

不得用“全量通过”替代上述说明，也不得把 unsigned `assembleRelease` 描述为已签名或已发布 APK。
