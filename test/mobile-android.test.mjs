import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");
const androidSourceRoot =
  "mobile/android/app/src/main/java/com/tmuxworktree/mobile";

function descendantFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? descendantFiles(path) : [path];
  });
}

const androidSourcesByName = new Map();
for (const path of descendantFiles(androidSourceRoot)) {
  const name = basename(path);
  androidSourcesByName.set(name, [
    ...(androidSourcesByName.get(name) ?? []),
    path,
  ]);
}

function readAndroidSource(fileName) {
  const matches = androidSourcesByName.get(fileName) ?? [];
  assert.equal(
    matches.length,
    1,
    `expected one Android source named ${fileName}, found ${matches
      .map((path) => relative(androidSourceRoot, path))
      .join(", ")}`,
  );
  return read(matches[0]);
}

function readUniqueSourceContaining(directory, marker) {
  const matches = descendantFiles(directory).filter((path) =>
    read(path).includes(marker),
  );
  assert.equal(
    matches.length,
    1,
    `expected one source under ${directory} containing ${marker}, found ${matches
      .map((path) => relative(directory, path))
      .join(", ")}`,
  );
  return read(matches[0]);
}

test("Android V2 terminal is bundled, sandboxed, and refits after viewport changes", () => {
  const html = read("mobile/android/app/src/main/assets/xterm/index.html");
  const webView = readAndroidSource("TerminalWebView.kt");
  const relayActor = readAndroidSource("RelayV1ConnectionActor.kt");
  const actionQueue = readAndroidSource("RelayActionQueue.kt");
  const socketIngress = readAndroidSource("RelayV1SocketIngress.kt");
  const viewModel = readAndroidSource("V2ViewModel.kt");
  const registries = readAndroidSource("RelayRegistries.kt");

  assert.match(html, /<script src="xterm\.js"><\/script>/);
  assert.match(html, /<script src="xterm-addon-fit\.js"><\/script>/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /function fitBurst\(\)/);
  assert.match(html, /visualViewport\.addEventListener\('resize', fitBurst\)/);
  assert.match(html, /new ResizeObserver\(fitBurst\)/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.match(
    html,
    /terminal\.cols !== lastCols \|\| terminal\.rows !== lastRows/,
  );
  assert.match(webView, /WebViewAssetLoader\.AssetsPathHandler\(context\)/);
  assert.match(webView, /settings\.allowFileAccess = false/);
  assert.match(webView, /settings\.allowContentAccess = false/);
  assert.match(webView, /settings\.mixedContentMode = WebSettings\.MIXED_CONTENT_NEVER_ALLOW/);
  assert.match(webView, /modifier = modifier\.clipToBounds\(\)/);
  assert.match(webView, /MAX_PENDING_TERMINAL_CHARS = 1024 \* 1024/);
  assert.match(webView, /Terminal output truncated: client buffer limit reached/);
  assert.match(webView, /evaluateJavascript\(script\) \{/);
  assert.match(relayActor, /terminalOutputBuffer\.append\(data\)/);
  assert.match(relayActor, /delay\(terminalOutputBatchMillis\.coerceAtLeast\(1\)\)/);
  assert.match(relayActor, /MAX_TERMINAL_OUTPUT_BATCH_CHARS = 64 \* 1024/);
  assert.match(relayActor, /BoundedActionQueue<Action>\(/);
  assert.match(actionQueue, /normalSlots = Semaphore\(validatedNormalCapacity\)/);
  assert.match(
    actionQueue,
    /Channel<QueuedAction<T>>\([\s\S]*validatedNormalCapacity \+ validatedReservedCapacity/,
  );
  assert.match(socketIngress, /callbackIngressLock = Any\(\)/);
  assert.match(relayActor, /Channel<RelayClientEvent>\(MAX_PENDING_EVENTS\)/);
  assert.doesNotMatch(relayActor, /Channel\.UNLIMITED/);
  assert.doesNotMatch(relayActor, /runBlocking/);
  assert.doesNotMatch(relayActor, /urgentActions|Action\.DrainThen/);
  assert.match(relayActor, /actionInput\.trySendReserved\(Action\.Shutdown\)/);
  assert.match(relayActor, /completion\.completeExceptionally/);
  assert.match(viewModel, /Channel<V2UiEffect>\(MAX_PENDING_UI_EFFECTS\)/);
  assert.match(viewModel, /normalEffectSlots = Semaphore\(MAX_PENDING_UI_EFFECTS\)/);
  assert.match(
    viewModel,
    /effectInputChannel = Channel<QueuedUiEffect>\([\s\S]*MAX_PENDING_UI_EFFECTS \+ MAX_PENDING_CRITICAL_UI_EFFECTS/,
  );
  assert.doesNotMatch(viewModel, /Channel\.UNLIMITED/);
  const effectEmitter = viewModel.slice(
    viewModel.indexOf("private fun emit(effect"),
    viewModel.indexOf("private suspend fun emitAwait"),
  );
  assert.doesNotMatch(effectEmitter, /viewModelScope\.launch/);
  assert.match(registries, /return !streamId\.isNullOrEmpty\(\) && streamId == active\.streamId/);
  assert.match(
    relayActor,
    /handleTerminalExit[\s\S]*flushTerminalOutput\(active\.streamId\)[\s\S]*RelayClientEvent\.TerminalExit/,
  );
});

test("Android package is on the V2 Compose line and V2Activity owns the launcher", () => {
  const gradle = read("mobile/android/app/build.gradle.kts");
  const wrapper = read("mobile/android/gradle/wrapper/gradle-wrapper.properties");
  const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
  const activityBlocks = [
    ...manifest.matchAll(/<activity\b[^>]*\/>|<activity\b[^>]*>[\s\S]*?<\/activity>/g),
  ].map((match) => match[0]);
  const v2Activity = activityBlocks.find((block) =>
    block.includes('android:name=".V2Activity"'),
  );
  const legacyActivity = activityBlocks.find((block) =>
    block.includes('android:name=".MainActivity"'),
  );
  const versionCode = Number(gradle.match(/versionCode\s*=\s*(\d+)/)?.[1]);
  const versionName = gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
  const repositoryVersion = JSON.parse(read("package.json")).version;

  assert.ok(versionCode >= 20000, `expected V2 versionCode, got ${versionCode}`);
  assert.equal(versionName, repositoryVersion);
  assert.match(gradle, /id\("org\.jetbrains\.kotlin\.plugin\.compose"\)/);
  assert.match(gradle, /compose = true/);
  assert.match(gradle, /androidx\.room:room-runtime/);
  assert.match(wrapper, /distributionSha256Sum=[a-f0-9]{64}/);
  assert.ok(v2Activity, "V2Activity must be declared");
  assert.match(v2Activity, /android:exported="true"/);
  assert.match(v2Activity, /android\.intent\.action\.MAIN/);
  assert.match(v2Activity, /android\.intent\.category\.LAUNCHER/);
  assert.doesNotMatch(manifest, /android\.intent\.category\.BROWSABLE/);
  assert.doesNotMatch(manifest, /android:scheme="tmuxworktree"/);
  assert.ok(legacyActivity, "legacy MainActivity must remain directly addressable internally");
  assert.doesNotMatch(legacyActivity, /android\.intent\.action\.MAIN/);
  assert.match(legacyActivity, /android:exported="false"/);
});

test("Android creation flows cannot escape or resubmit while a request is in flight", () => {
  const app = readAndroidSource("V2App.kt");
  const worktree = readAndroidSource("NewWorktreeScreen.kt");

  assert.match(app, /navigateAfterCreation\(/);
  assert.match(app, /popUpTo\(formRoute\) \{ inclusive = true \}/);
  assert.match(app, /BackHandler\(enabled = state\.creatingTerminal\)/);
  assert.match(worktree, /NewWorktreeTopBar\([\s\S]*isCreating = isCreating/);
  assert.match(worktree, /IconButton\([\s\S]*enabled = !isCreating[\s\S]*testTag\("topbar_back"\)/);
});

test("exported Android V2 demo launch modes are debug-only", () => {
  const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
  const activity = readAndroidSource("V2Activity.kt");
  const exportedV2 = manifest.match(
    /<activity\b[^>]*android:name="\.V2Activity"[^>]*android:exported="true"[^>]*>/,
  );

  assert.ok(exportedV2, "the exported V2 Activity is a release-facing boundary");
  assert.match(
    activity,
    /private val demoMode:[\s\S]*?BuildConfig\.DEBUG\s*&&\s*intent\.getBooleanExtra\(EXTRA_DEMO_MODE, false\)/,
  );
  assert.match(
    activity,
    /private val demoRecovering:[\s\S]*?BuildConfig\.DEBUG\s*&&\s*intent\.getBooleanExtra\(EXTRA_DEMO_RECOVERING, false\)/,
  );
});

test("Android app data cannot enter backup or device transfer", () => {
  const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
  const legacyRules = read(
    "mobile/android/app/src/main/res/xml/backup_rules.xml",
  );
  const extractionRules = read(
    "mobile/android/app/src/main/res/xml/data_extraction_rules.xml",
  );
  const cloudBackup = extractionRules.match(
    /<cloud-backup(?:\s[^>]*)?>([\s\S]*?)<\/cloud-backup>/,
  )?.[1];
  const deviceTransfer = extractionRules.match(
    /<device-transfer(?:\s[^>]*)?>([\s\S]*?)<\/device-transfer>/,
  )?.[1];
  const privateDomains = [
    "root",
    "file",
    "database",
    "sharedpref",
    "external",
    "device_root",
    "device_file",
    "device_database",
    "device_sharedpref",
  ];

  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(
    manifest,
    /android:dataExtractionRules="@xml\/data_extraction_rules"/,
  );
  assert.match(legacyRules, /<full-backup-content>/);
  assert.ok(cloudBackup, "Android 12+ cloud-backup rules must exist");
  assert.ok(deviceTransfer, "Android 12+ device-transfer rules must exist");

  for (const domain of privateDomains) {
    const exclusion = new RegExp(
      `<exclude\\s+domain="${domain}"\\s+path="\\."\\s*/>`,
    );
    assert.match(legacyRules, exclusion, `legacy backup must exclude ${domain}`);
    assert.match(cloudBackup, exclusion, `cloud backup must exclude ${domain}`);
    assert.match(deviceTransfer, exclusion, `device transfer must exclude ${domain}`);
  }
});

test("Android V2 workspace list groups cached sessions by project and scope", () => {
  const screen = readAndroidSource("WorkspacesScreen.kt");
  const models = readAndroidSource("SessionModels.kt");
  const repository = readAndroidSource("TwRepository.kt");

  assert.match(
    screen,
    /worktreeSessions\.groupBy \{ it\.projectName to it\.scopeLabel\.ifBlank \{ it\.scopeId \} \}/,
  );
  assert.match(screen, /scope_filter_all/);
  assert.match(screen, /scope_filter_\$\{scope\.scopeId\}/);
  assert.match(screen, /workspace_group_\$\{group\.second\}/);
  assert.match(models, /val projectName: String/);
  assert.match(models, /\/\.tmux-worktree\/worktrees\//);
  assert.match(repository, /val sessions: Flow<List<RelaySession>>/);
  assert.match(repository, /replaceSessions\(hostId: String, sessions: List<RelaySession>\)/);
});

test("Android V2 connection profile is editable, clearable, and never persists plaintext credentials", () => {
  const pairing = readAndroidSource("PairingScreen.kt");
  const preferences = readAndroidSource("PreferencesStore.kt");
  const credentials = readAndroidSource("CredentialStore.kt");
  const importer = readAndroidSource("LegacyIdentityImporter.kt");
  const viewModel = readAndroidSource("V2ViewModel.kt");

  assert.match(pairing, /onRelayUrlChange: \(String\) -> Unit/);
  assert.match(pairing, /onTokenChange: \(String\) -> Unit/);
  assert.match(pairing, /testTag\("pairing_relay_url"\)/);
  assert.match(pairing, /testTag\("pairing_token"\)/);
  assert.match(preferences, /suspend fun clearProfile\(\)/);
  assert.match(preferences, /preferences\.remove\(Keys\.relayUrl\)/);
  assert.match(preferences, /preferences\.remove\(Keys\.hostId\)/);
  assert.match(preferences, /preferences\[Keys\.autoConnect\] = false/);
  assert.match(credentials, /AndroidKeyStore/);
  assert.match(credentials, /AES\/GCM\/NoPadding/);
  assert.match(credentials, /KEY_CIPHERTEXT/);
  assert.match(credentials, /val persisted = preferences\.edit\(\)[\s\S]*\.commit\(\)/);
  assert.doesNotMatch(credentials, /\.apply\(\)/);
  assert.match(importer, /\.remove\("relaySecret"\)\.commit\(\)/);
  assert.doesNotMatch(importer, /\.remove\("relaySecret"\)\.apply\(\)/);
  assert.match(
    importer,
    /removeLingeringPlaintext\(legacy\)[\s\S]*preferencesStore\.setLegacyIdentityMigrated\(\)/,
  );
  assert.match(importer, /legacyIdentityMigrated\) \{[\s\S]*removeLingeringPlaintext\(legacy\)/);
  assert.match(
    importer,
    /if \(relayUrl\.isBlank\(\) \|\| relaySecret\.isBlank\(\)\) \{[\s\S]*removeLingeringPlaintext\(legacy\)[\s\S]*setLegacyIdentityMigrated/,
  );
  assert.match(importer, /Legacy plaintext credential was not removed/);
  assert.match(
    viewModel,
    /private fun connectActiveProfile[\s\S]*validatePairing\(relayUrl, token, hostId\)[\s\S]*pairingRequired = true/,
  );
});

test("Android V2 requires confirmation and clears credential-bound data before profile changes", () => {
  const activity = readAndroidSource("V2Activity.kt");
  const viewModel = readAndroidSource("V2ViewModel.kt");
  const intentStart = activity.indexOf("private fun consumePairingIntent");
  const qrStart = activity.indexOf("private fun scanPairingQr", intentStart);
  const companionStart = activity.indexOf("companion object", qrStart);
  const intentHandler = activity.slice(intentStart, qrStart);
  const qrHandler = activity.slice(qrStart, companionStart);
  const forgetStart = viewModel.indexOf("fun forgetPairing()");
  const connectStart = viewModel.indexOf("fun connectPairing()", forgetStart);
  const confirmStart = viewModel.indexOf("fun confirmProfileSwitch()", connectStart);
  const cancelStart = viewModel.indexOf("fun cancelProfileSwitch()", confirmStart);
  const persistStart = viewModel.indexOf("private fun persistPairing", cancelStart);
  const retryStart = viewModel.indexOf("fun retryConnection()", persistStart);
  const forgetPairing = viewModel.slice(forgetStart, connectStart);
  const connectPairing = viewModel.slice(connectStart, confirmStart);
  const confirmProfileSwitch = viewModel.slice(confirmStart, cancelStart);
  const persistPairing = viewModel.slice(persistStart, retryStart);

  assert.ok(intentStart >= 0 && qrStart > intentStart && companionStart > qrStart);
  assert.ok(forgetStart >= 0 && connectStart > forgetStart && confirmStart > connectStart);
  assert.ok(persistStart > cancelStart && retryStart > persistStart);

  // Both exported Intent/deep-link input and scanned QR data only prefill reviewable fields.
  assert.match(intentHandler, /applyPairingPayload\(payload, connectImmediately = false\)/);
  assert.doesNotMatch(intentHandler, /connectImmediately = true/);
  assert.match(qrHandler, /applyPairingPayload\(payload, connectImmediately = false\)/);
  assert.doesNotMatch(qrHandler, /connectImmediately = true/);

  // Any URL, host, or token change on an existing pairing stops at confirmation.
  assert.match(
    connectPairing,
    /val existingProfile = current\.hasStoredProfile \|\| credentials\.hasCredential\(\)/,
  );
  assert.match(connectPairing, /changesExistingProfile = existingProfile && \(/);
  assert.match(connectPairing, /current\.preferences\.relayUrl\.trimEnd\('\/'\) != relayUrl/);
  assert.match(connectPairing, /current\.preferences\.preferredHostId != hostId/);
  assert.match(connectPairing, /credentials\.read\(\) != token/);
  assert.match(
    connectPairing,
    /if \(changesExistingProfile\) \{[\s\S]*confirmProfileSwitch = true[\s\S]*return[\s\S]*\}/,
  );
  assert.match(
    connectPairing,
    /persistPairing\([\s\S]*clearExistingProfile = !current\.paired,\s*\)/,
  );
  assert.match(confirmProfileSwitch, /persistPairing\([\s\S]*clearExistingProfile = true\)/);

  // Confirmation clears old preferences, key material, and Room data before writing the new token.
  assert.match(
    persistPairing,
    /if \(clearExistingProfile\) \{[\s\S]*preferencesStore\.clearProfile\(\)[\s\S]*credentials\.clear\(\)[\s\S]*repository\.clearProfileData\(\)[\s\S]*\}[\s\S]*credentials\.write\(token\)/,
  );

  // Explicit forget follows the same cache/key/profile erasure contract.
  assert.match(forgetPairing, /repository\.clearProfileData\(\)/);
  assert.match(forgetPairing, /credentials\.clear\(\)/);
  assert.match(forgetPairing, /preferencesStore\.clearProfile\(\)/);
});

test("Android V2 terminal stream recovery reopens only the desired active session", () => {
  const actor = readAndroidSource("RelayV1ConnectionActor.kt");
  const registries = readAndroidSource("RelayRegistries.kt");

  assert.match(actor, /private var desiredTerminal: DesiredTerminal\?/);
  assert.match(actor, /private var pendingReopenGeneration: Long\?/);
  assert.match(actor, /normalized\.contains\("terminal stream is not open"\)/);
  assert.match(actor, /streams\.accepts\(event\.streamId\)/);
  assert.match(actor, /Action\.ReopenTerminal\(transport\.epoch, active\.generation\)/);
  assert.match(actor, /action\.epoch != transport\.epoch/);
  assert.match(actor, /pendingReopenGeneration != action\.generation/);
  assert.match(actor, /resetDisplay = false/);
  assert.match(registries, /fun accepts\(streamId: String\?\): Boolean/);
});

test("mobile relay failures stay visible on Android and in the Dashboard", () => {
  const reducer = readAndroidSource("RelayConnectionReducer.kt");
  const healthScreen = readAndroidSource("ConnectionHealthScreen.kt");
  const app = readUniqueSourceContaining(
    "app/src",
    "useMobileRelayController({ hosts })",
  );
  const dashboard = read(
    "app/src/dashboard/hooks/useMobileRelayController.ts",
  );
  const backend = readUniqueSourceContaining(
    "app/src-tauri/src",
    "load_mobile_relay_runtime_status",
  );

  assert.match(reducer, /TransportPhase\.BACKING_OFF/);
  assert.match(reducer, /ConnectionStatus\.AUTH_REQUIRED/);
  assert.match(reducer, /retryAtMillis = nowMillis \+ delay/);
  assert.match(healthScreen, /testTag\("health_retry"\)/);
  assert.match(healthScreen, /testTag\("health_retry_countdown"\)/);
  assert.match(healthScreen, /health\.errorMessage/);
  assert.match(app, /useMobileRelayController\(\{ hosts \}\)/);
  assert.match(dashboard, /useVisibilityAwarePolling\(refreshStatus/);
  assert.match(dashboard, /MOBILE_RELAY_VISIBLE_REFRESH_MS = 2_000/);
  assert.match(dashboard, /MOBILE_RELAY_HIDDEN_REFRESH_MS = 15_000/);
  assert.match(dashboard, /connected\s*\? "Connected"/);
  assert.match(backend, /connection_state: String/);
  assert.match(backend, /load_mobile_relay_runtime_status/);
  assert.match(
    backend,
    /status\.relay_url == resolved_relay_url && status\.host_id == resolved_host_id/,
  );
});

test("Android V2 terminal supports touch scrolling through bundled xterm scrollback", () => {
  const html = read("mobile/android/app/src/main/assets/xterm/index.html");

  assert.match(html, /scrollback: 5000/);
  assert.match(html, /function installTouchScroll\(\)/);
  assert.match(html, /addEventListener\('touchstart'/);
  assert.match(html, /addEventListener\('touchmove'/);
  assert.match(html, /passive: false, capture: true/);
  assert.match(html, /event\.preventDefault\(\)/);
  assert.match(html, /terminal\.scrollLines\(-whole\)/);
  assert.match(html, /installTouchScroll\(\)/);
});

test("Android V2 outbox makes queued delivery durable and state transitions explicit", () => {
  const repository = readAndroidSource("TwRepository.kt");
  const entities = readAndroidSource("Entities.kt");

  assert.match(repository, /database\.withTransaction/);
  assert.match(repository, /dao\.insertOutbox\(message\.toEntity\(\)\)/);
  assert.match(repository, /dao\.upsertTimeline\(timeline\.toEntity\(\)\)/);
  assert.match(repository, /Invalid outbox transition/);
  assert.match(repository, /DeliveryState\.FAILED_RETRYABLE/);
  assert.match(repository, /dao\.expireOutbox\(now\)/);
  assert.match(entities, /tableName = "outbox"/);
  assert.match(entities, /Index\(value = \["requestId"\], unique = true\)/);
});

test("Android app declares adaptive launcher icons", () => {
  const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
  const foreground = read(
    "mobile/android/app/src/main/res/drawable/ic_launcher_foreground.xml",
  );
  const adaptive = read(
    "mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
  );
  const adaptiveRound = read(
    "mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml",
  );
  const monochrome = read(
    "mobile/android/app/src/main/res/drawable/ic_launcher_monochrome.xml",
  );

  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  assert.match(foreground, /<vector /);
  assert.match(adaptive, /<adaptive-icon/);
  assert.match(adaptive, /@drawable\/ic_launcher_foreground/);
  assert.match(monochrome, /<vector /);
  assert.match(adaptive, /<monochrome android:drawable="@drawable\/ic_launcher_monochrome"/);
  assert.match(adaptiveRound, /<monochrome android:drawable="@drawable\/ic_launcher_monochrome"/);
});
