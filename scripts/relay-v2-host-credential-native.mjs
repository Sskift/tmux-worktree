import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  posix,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FdOwnedNativeStageError,
  atomicallyStageFdOwnedNativeArtifact,
  verifyNativeArtifactFd,
} from "./internal/relayV2BrokerCredentialNativeStage.mjs";
import {
  NativeTarInspectionError,
  inspectAndExtractNpmPackTar,
} from "./internal/relayV2BrokerCredentialNativeTar.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const DIST_LOADER_DIRECTORY = join(REPOSITORY_ROOT, "dist", "relay", "v2");
const NAPI_CRATE_DIRECTORY = join(
  REPOSITORY_ROOT,
  "native",
  "relay-v2-host-credential-atomic-file-cell-napi",
);
const NATIVE_TEST_FILE = "test/relay-v2-host-credential-atomic-file-cell-native-binding.test.mjs";
const FORBIDDEN_LIFECYCLE_SCRIPTS = Object.freeze([
  "prepack",
  "prepare",
  "postpack",
  "preinstall",
  "install",
  "postinstall",
]);

class FoundationError extends Error {
  constructor(message) {
    super(message);
    this.name = "FoundationError";
  }
}

function fail(message) {
  throw new FoundationError(message);
}

function bytesEqual(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readUint16(bytes, offset, littleEndian) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint16(offset, littleEndian);
}

function readUint32(bytes, offset, littleEndian) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset, littleEndian);
}

/**
 * Reads only executable-format identity. A filename or selected target never
 * substitutes for the Mach-O/ELF OS and architecture evidence.
 */
export function inspectNativeBinaryHeader(input) {
  const bytes = input instanceof Uint8Array ? input : null;
  if (bytes === null || bytes.byteLength < 24) fail("native binary header is invalid");

  const machLittle = bytesEqual(bytes, [0xcf, 0xfa, 0xed, 0xfe]);
  const machBig = bytesEqual(bytes, [0xfe, 0xed, 0xfa, 0xcf]);
  if (machLittle || machBig) {
    if (bytes.byteLength < 32) fail("native binary header is invalid");
    const littleEndian = machLittle;
    const cpuType = readUint32(bytes, 4, littleEndian);
    const fileType = readUint32(bytes, 12, littleEndian);
    if (fileType !== 6) fail("native binary is not a Mach-O dynamic library");
    const architecture = cpuType === 0x0100000c
      ? "arm64"
      : cpuType === 0x01000007
        ? "x64"
        : null;
    if (architecture === null) fail("native binary architecture is unsupported");
    return Object.freeze({ platform: "darwin", architecture });
  }

  if (bytesEqual(bytes, [0x7f, 0x45, 0x4c, 0x46])) {
    if (bytes.byteLength < 64) fail("native binary header is invalid");
    if (bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1) {
      fail("native binary is not a supported 64-bit little-endian ELF image");
    }
    if (bytes[7] !== 0 && bytes[7] !== 3) {
      fail("native binary ELF OS ABI is unsupported");
    }
    if (readUint16(bytes, 16, true) !== 3 || readUint32(bytes, 20, true) !== 1) {
      fail("native binary is not an ELF shared object");
    }
    const machine = readUint16(bytes, 18, true);
    const architecture = machine === 183
      ? "arm64"
      : machine === 62
        ? "x64"
        : null;
    if (architecture === null) fail("native binary architecture is unsupported");
    return Object.freeze({ platform: "linux", architecture });
  }

  fail("native binary format is unsupported");
}

export function assertNativeBinaryMatchesDescriptor(bytes, descriptor) {
  const identity = inspectNativeBinaryHeader(bytes);
  if (
    identity.platform !== descriptor?.platform
    || identity.architecture !== descriptor?.architecture
  ) {
    fail("native binary target does not match the selected target");
  }
  return identity;
}

function fixedRuntimeArtifactRelativePath(descriptor) {
  const specifier = descriptor?.loaderModuleSpecifier;
  if (
    typeof specifier !== "string"
    || !specifier.startsWith("./native/")
    || specifier.includes("\\")
    || specifier.split("/").some((component) => component === ".." || component === "")
  ) {
    fail("native target descriptor is invalid");
  }
  const relative = specifier.slice(2);
  if (relative !== `native/${descriptor.runtimeArtifactFileName}`) {
    fail("native target descriptor is invalid");
  }
  return relative;
}

function fixedStagedArtifactPath(descriptor, loaderDirectory = DIST_LOADER_DIRECTORY) {
  const relative = fixedRuntimeArtifactRelativePath(descriptor);
  if (descriptor.stagedRelativePath !== `dist/relay/v2/${relative}`) {
    fail("native target descriptor is invalid");
  }
  return join(loaderDirectory, ...relative.split("/"));
}

function expectedPackedArtifactPath(descriptor) {
  const relative = fixedRuntimeArtifactRelativePath(descriptor);
  const packed = posix.join("package/dist/relay/v2", relative);
  if (descriptor.packedRelativePath !== packed) {
    fail("native target descriptor is invalid");
  }
  return packed;
}

function normalizeTarEntry(entry) {
  if (
    entry === null
    || typeof entry !== "object"
    || typeof entry.path !== "string"
    || (entry.type !== "file" && entry.type !== "directory")
    || !Number.isSafeInteger(entry.size)
    || entry.size < 0
    || entry.path.length === 0
    || entry.path.includes("\\")
  ) {
    fail("npm pack tar layout is invalid");
  }
  if (
    entry.path.startsWith("/")
    || entry.path.endsWith("/")
    || posix.normalize(entry.path) !== entry.path
    || entry.path.split("/").some((component) => component.length === 0)
    || (entry.path !== "package" && !entry.path.startsWith("package/"))
    || (entry.type === "directory" && entry.size !== 0)
  ) {
    fail("npm pack tar layout is invalid");
  }
  return Object.freeze({ path: entry.path, type: entry.type, size: entry.size });
}

/** Exact native subset of an npm pack tar layout; other package files stay free to evolve. */
export function validateNpmPackTarEntries(entries, descriptor, siblingFileNames = []) {
  if (!Array.isArray(entries)) fail("npm pack tar layout is invalid");
  const normalized = entries.map(normalizeTarEntry);
  const identities = normalized.map(({ path }) => path);
  if (new Set(identities).size !== identities.length) {
    fail("npm pack tar layout contains duplicate entries");
  }

  const expectedArtifact = expectedPackedArtifactPath(descriptor);
  const nativeDirectory = posix.dirname(expectedArtifact);
  const allowedArtifacts = new Set([
    expectedArtifact,
    ...siblingFileNames.map((name) => posix.join(nativeDirectory, name)),
  ]);
  const nativeEntries = normalized.filter(({ path }) => (
    path === nativeDirectory
    || path.startsWith(`${nativeDirectory}/`)
    || path.split("/").some((component) => (
      component.startsWith(".relay-v2-native-stage-")
    ))
    || /\.(?:node|dylib|so|dll)$/.test(path)
  ));
  const expectedEntry = normalized.filter(({ path }) => path === expectedArtifact);
  if (
    expectedEntry.length !== 1
    || expectedEntry[0].type !== "file"
    || nativeEntries.some((entry) => (
      entry.path === nativeDirectory
        ? entry.type !== "directory"
        : entry.type !== "file" || !allowedArtifacts.has(entry.path)
    ))
  ) {
    fail(
      "npm pack tar layout must contain exactly the selected native artifact of this owner"
      + " and only frozen sibling-owner artifacts",
    );
  }
  return expectedArtifact;
}

async function assertRegularFileNoFollow(path, purpose, requireSingleLink = false) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
    );
  } catch {
    fail(`${purpose} cannot be opened without following links`);
  }
  try {
    const status = await handle.stat();
    if (!status.isFile()) fail(`${purpose} is not a regular file`);
    if (requireSingleLink && status.nlink !== 1) {
      fail(`${purpose} has an invalid link count`);
    }
    return status;
  } finally {
    await handle.close();
  }
}

async function assertLoaderBuildExists() {
  for (const name of [
    "hostCredentialNativeLoader.js",
    "hostCredentialNativeTarget.js",
    "hostCredentialNativeModuleSource.js",
  ]) {
    await assertRegularFileNoFollow(
      join(DIST_LOADER_DIRECTORY, name),
      "ordinary build output",
    );
  }
}

async function assertNativeStageAbsent(descriptor, siblingFileNames) {
  const nativeDirectory = dirname(fixedStagedArtifactPath(descriptor));
  let loaderEntries;
  try {
    loaderEntries = await readdir(DIST_LOADER_DIRECTORY);
  } catch {
    fail("ordinary build loader directory cannot be inspected");
  }
  if (loaderEntries.some((name) => name.startsWith(".relay-v2-native-stage-"))) {
    fail("a stale private native staging directory already exists");
  }
  let names;
  try {
    names = await readdir(nativeDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("native staging destination cannot be inspected");
  }
  const allowed = new Set(siblingFileNames);
  if (names.some((name) => !allowed.has(name))) {
    fail("native staging destination contains stale or unknown entries");
  }
  for (const name of names) {
    let status;
    try {
      status = await lstat(join(nativeDirectory, name));
    } catch {
      fail("native staging destination entry cannot be inspected");
    }
    if (!status.isFile() || status.isSymbolicLink()) {
      fail("native staging destination entry is not a regular sibling artifact");
    }
  }
}

async function assertFixedStagedLayout(
  descriptor,
  siblingFileNames,
  loaderDirectory = DIST_LOADER_DIRECTORY,
) {
  const artifact = fixedStagedArtifactPath(descriptor, loaderDirectory);
  const nativeDirectory = dirname(artifact);
  let directoryStatus;
  try {
    directoryStatus = await lstat(nativeDirectory);
  } catch {
    fail("native staging directory is missing");
  }
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    fail("native staging directory is invalid");
  }
  const names = await readdir(nativeDirectory);
  const allowed = new Set([basename(artifact), ...siblingFileNames]);
  if (
    names.some((name) => !allowed.has(name))
    || names.filter((name) => name === basename(artifact)).length !== 1
  ) {
    fail("native staging directory contains stale or unknown entries");
  }
  for (const name of names) {
    if (name === basename(artifact)) continue;
    let status;
    try {
      status = await lstat(join(nativeDirectory, name));
    } catch {
      fail("native staging directory entry cannot be inspected");
    }
    if (!status.isFile() || status.isSymbolicLink()) {
      fail("native staging directory entry is not a regular sibling artifact");
    }
  }
  await verifyNativeArtifactFd(
    artifact,
    (bytes) => assertNativeBinaryMatchesDescriptor(bytes, descriptor),
    { requireSingleLink: true },
  );
  return artifact;
}

function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(options.failureMessage ?? "explicit native foundation command failed");
  }
  return result.stdout;
}

async function loadTargetDescriptor(target) {
  const modulePath = join(
    DIST_LOADER_DIRECTORY,
    "hostCredentialNativeTarget.js",
  );
  let targetModule;
  try {
    targetModule = await import(pathToFileURL(modulePath).href);
  } catch {
    fail("ordinary npm build output is required before native staging");
  }
  const descriptor = targetModule
    .getRelayV2HostCredentialNativeTargetDescriptor(target);
  if (descriptor === null) fail("native target is unsupported");
  return descriptor;
}

// The frozen sibling-owner artifact name for the exact same target is
// enumerated from the broker's own fixed target descriptor module; literals
// are never copied here, and no other target's artifact is ever allowed.
async function loadSiblingFrozenArtifactNames(target) {
  const modulePath = join(
    DIST_LOADER_DIRECTORY,
    "brokerCredentialStateStoreNativeTarget.js",
  );
  let targetModule;
  try {
    targetModule = await import(pathToFileURL(modulePath).href);
  } catch {
    fail("ordinary npm build output is required before native staging");
  }
  const descriptor = targetModule
    .getRelayV2BrokerCredentialStateStoreNativeTargetDescriptor?.(target);
  const specifier = descriptor?.runtimeArtifact?.moduleSpecifier;
  if (
    typeof specifier !== "string"
    || !specifier.startsWith("./native/")
    || specifier.includes("\\")
    || specifier.split("/").some((component) => component === ".." || component === "")
  ) {
    fail("frozen sibling native target descriptor is invalid");
  }
  return Object.freeze([specifier.slice("./native/".length)]);
}

function parseTargetArgument(args) {
  if (
    args.length !== 2
    || args[0] !== "--target"
    || typeof args[1] !== "string"
    || args[1].length === 0
  ) {
    fail("exactly one explicit --target is required");
  }
  return args[1];
}

async function stage(target) {
  const descriptor = await loadTargetDescriptor(target);
  const siblingFileNames = await loadSiblingFrozenArtifactNames(descriptor.target);
  await assertLoaderBuildExists();
  await assertNativeStageAbsent(descriptor, siblingFileNames);

  const cargoTargetRoot = join(NAPI_CRATE_DIRECTORY, "target");
  runCaptured(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      descriptor.cargoTargetTriple,
      "--manifest-path",
      join(NAPI_CRATE_DIRECTORY, "Cargo.toml"),
    ],
    {
      env: { ...process.env, CARGO_TARGET_DIR: cargoTargetRoot },
      failureMessage: "locked release Cargo build failed",
    },
  );

  const cargoArtifact = join(
    cargoTargetRoot,
    descriptor.cargoTargetTriple,
    "release",
    descriptor.cargoDynamicLibraryFileName,
  );
  await atomicallyStageFdOwnedNativeArtifact({
    sourcePath: cargoArtifact,
    finalPath: fixedStagedArtifactPath(descriptor),
    verifyHeader: (bytes) => assertNativeBinaryMatchesDescriptor(bytes, descriptor),
    allowedPreExistingFinalEntries: siblingFileNames,
  });
  process.stdout.write(`staged closed native artifact for ${descriptor.target}\n`);
}

async function readJsonFile(path, purpose) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`${purpose} is invalid`);
    }
    return value;
  } catch (error) {
    if (error instanceof FoundationError) throw error;
    fail(`${purpose} is invalid`);
  }
}

function assertPackLifecycleIsExplicit(packageJson) {
  const scripts = packageJson.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    fail("package scripts are invalid");
  }
  if (FORBIDDEN_LIFECYCLE_SCRIPTS.some((name) => Object.hasOwn(scripts, name))) {
    fail("native packaging must not use npm lifecycle scripts");
  }
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => typeof value === "string" && value === right[index]);
}

const DESCRIPTOR_FIELDS = Object.freeze([
  "target",
  "platform",
  "architecture",
  "cargoTargetTriple",
  "cargoDynamicLibraryFileName",
  "runtimeArtifactFileName",
  "loaderModuleSpecifier",
  "stagedRelativePath",
  "packedRelativePath",
]);

async function verifyUnpackedPackage(
  extractedFiles,
  tarEntries,
  descriptor,
  sourcePackageJson,
  siblingFileNames,
) {
  const expectedTarArtifact = validateNpmPackTarEntries(
    tarEntries,
    descriptor,
    siblingFileNames,
  );
  const packageJsonPath = extractedFiles.get("package/package.json");
  const targetModule = extractedFiles.get(
    "package/dist/relay/v2/hostCredentialNativeTarget.js",
  );
  const loaderModule = extractedFiles.get(
    "package/dist/relay/v2/hostCredentialNativeLoader.js",
  );
  const holderModule = extractedFiles.get(
    "package/dist/relay/v2/hostCredentialNativeModuleSource.js",
  );
  const artifact = extractedFiles.get(expectedTarArtifact);
  if (
    packageJsonPath === undefined
    || targetModule === undefined
    || loaderModule === undefined
    || holderModule === undefined
    || artifact === undefined
  ) {
    fail("npm pack tarball is missing required packed modules");
  }
  const unpackedPackageJson = await readJsonFile(
    packageJsonPath,
    "unpacked package metadata",
  );
  assertPackLifecycleIsExplicit(unpackedPackageJson);
  if (
    unpackedPackageJson.name !== sourcePackageJson.name
    || unpackedPackageJson.version !== sourcePackageJson.version
    || !sameStringArray(unpackedPackageJson.files, sourcePackageJson.files)
    || !unpackedPackageJson.files.includes("dist")
  ) {
    fail("unpacked package metadata does not match the repository package");
  }

  const nativeDirectory = dirname(artifact);
  let directoryStatus;
  try {
    directoryStatus = await lstat(nativeDirectory);
  } catch {
    fail("unpacked native directory is missing");
  }
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    fail("unpacked native directory is invalid");
  }
  const names = await readdir(nativeDirectory);
  if (names.length !== 1 || names[0] !== basename(artifact)) {
    fail("unpacked native directory contains stale or unknown entries");
  }
  await verifyNativeArtifactFd(
    artifact,
    (bytes) => assertNativeBinaryMatchesDescriptor(bytes, descriptor),
    { requireSingleLink: true },
  );
  return Object.freeze({ artifact, targetModule, loaderModule, holderModule });
}

function parsePackOutput(stdout, packDirectory) {
  let records;
  try {
    records = JSON.parse(stdout);
  } catch {
    fail("npm pack did not return closed metadata");
  }
  if (
    !Array.isArray(records)
    || records.length !== 1
    || records[0] === null
    || typeof records[0] !== "object"
    || typeof records[0].filename !== "string"
    || basename(records[0].filename) !== records[0].filename
    || !records[0].filename.endsWith(".tgz")
  ) {
    fail("npm pack did not produce exactly one tarball");
  }
  return join(packDirectory, records[0].filename);
}

function exactOwnDataKeys(value) {
  if (value === null || typeof value !== "object") return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!Object.hasOwn(descriptor, "value")) return null;
  }
  return Reflect.ownKeys(descriptors).sort();
}

async function verifyUnpackedClosedBinding(unpacked, descriptor) {
  let unpackedTarget;
  let unpackedLoader;
  let unpackedHolder;
  try {
    unpackedTarget = await import(pathToFileURL(unpacked.targetModule).href);
    unpackedLoader = await import(pathToFileURL(unpacked.loaderModule).href);
    unpackedHolder = await import(pathToFileURL(unpacked.holderModule).href);
  } catch {
    fail("unpacked fixed native modules could not be imported");
  }
  const packedDescriptor = unpackedTarget
    .getRelayV2HostCredentialNativeTargetDescriptor?.(descriptor.target);
  if (
    packedDescriptor === null
    || packedDescriptor === undefined
    || DESCRIPTOR_FIELDS.some((field) => packedDescriptor[field] !== descriptor[field])
  ) {
    fail("unpacked native target descriptor does not match the repository descriptor");
  }
  const fixedLoader = unpackedLoader.relayV2HostCredentialNativeModuleFixedLoader;
  const createSource = unpackedHolder.createRelayV2HostCredentialNativeModuleSource;
  const openMethodName = unpackedHolder.RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_OPEN_METHOD;
  if (typeof fixedLoader !== "function"
    || typeof createSource !== "function"
    || openMethodName !== "openRelayV2HostCredentialAtomicFileCellV1") {
    fail("unpacked fixed native loader surface is invalid");
  }
  const source = createSource(
    Object.freeze({
      platform: process.platform,
      architecture: process.arch,
      napiVersion: Number(process.versions.napi),
    }),
    fixedLoader,
  );
  if (source?.capability?.().status !== "supported") {
    fail("unpacked fixed native loader did not load its same-package artifact");
  }
  let nativeModule;
  try {
    nativeModule = source.takeNativeModule();
  } catch {
    fail("unpacked native module source did not deliver its same-package artifact");
  }
  if (exactOwnDataKeys(nativeModule)?.length !== 1
    || exactOwnDataKeys(nativeModule)[0] !== openMethodName
    || typeof nativeModule[openMethodName] !== "function") {
    fail("unpacked native module ABI is invalid");
  }
  let openResult;
  try {
    openResult = nativeModule[openMethodName](Object.freeze({
      abiVersion: 1,
      operation: "open",
    }));
  } catch {
    fail("unpacked native module open did not return a closed result");
  }
  const resultKeys = exactOwnDataKeys(openResult);
  const errorKeys = exactOwnDataKeys(openResult?.error);
  if (
    resultKeys === null
    || resultKeys.join(",") !== "abiVersion,error,operation,outcome"
    || openResult.abiVersion !== 1
    || openResult.operation !== "open"
    || openResult.outcome !== "error"
    || errorKeys === null
    || errorKeys.join(",") !== "code"
    || openResult.error.code !== "CELL_DURABILITY_UNSUPPORTED"
  ) {
    fail("unpacked native module open did not fail closed before qualification");
  }
}

async function verifyPack(target) {
  const descriptor = await loadTargetDescriptor(target);
  const siblingFileNames = await loadSiblingFrozenArtifactNames(descriptor.target);
  if (
    descriptor.platform !== process.platform
    || descriptor.architecture !== process.arch
    || !Number.isSafeInteger(Number(process.versions.napi))
    || Number(process.versions.napi) < 9
  ) {
    fail("pack verification target does not match the current Node runtime");
  }
  await assertLoaderBuildExists();
  await assertFixedStagedLayout(descriptor, siblingFileNames);
  const sourcePackageJson = await readJsonFile(
    join(REPOSITORY_ROOT, "package.json"),
    "repository package metadata",
  );
  assertPackLifecycleIsExplicit(sourcePackageJson);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "tw-relay-v2-native-pack-"));
  let primaryError;
  try {
    const packDirectory = join(temporaryRoot, "pack");
    const unpackDirectory = join(temporaryRoot, "unpack");
    await mkdir(packDirectory);
    await mkdir(unpackDirectory);
    const packOutput = runCaptured(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory],
      { failureMessage: "npm pack --ignore-scripts failed" },
    );
    const tarball = parsePackOutput(packOutput, packDirectory);
    const tarballHandle = await open(
      tarball,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
    );
    let inspection;
    let inspectionError;
    try {
      const tarballStatus = await tarballHandle.stat();
      if (!tarballStatus.isFile() || tarballStatus.nlink !== 1) {
        fail("npm pack tarball is not an owned regular file");
      }
      const expectedArtifact = expectedPackedArtifactPath(descriptor);
      const selectedPaths = [
        "package/package.json",
        "package/dist/relay/v2/hostCredentialNativeTarget.js",
        "package/dist/relay/v2/hostCredentialNativeLoader.js",
        "package/dist/relay/v2/hostCredentialNativeModuleSource.js",
        expectedArtifact,
      ];
      inspection = await inspectAndExtractNpmPackTar({
        tarballHandle,
        extractionRoot: unpackDirectory,
        selectedFiles: new Map(selectedPaths.map((path) => [path, path])),
      });
    } catch (error) {
      inspectionError = error;
    }
    let tarballCloseFailed = false;
    try {
      await tarballHandle.close();
    } catch {
      tarballCloseFailed = true;
    }
    if (inspectionError !== undefined && tarballCloseFailed) {
      fail(
        `${safeErrorMessage(inspectionError)}; cleanup also failed: npm pack tarball close failed`,
      );
    }
    if (tarballCloseFailed) fail("npm pack tarball close failed");
    if (inspectionError !== undefined) throw inspectionError;
    const unpacked = await verifyUnpackedPackage(
      inspection.extracted,
      inspection.entries,
      descriptor,
      sourcePackageJson,
      siblingFileNames,
    );
    await verifyUnpackedClosedBinding(unpacked, descriptor);
    runCaptured(
      process.execPath,
      ["--test", "--test-concurrency=1", NATIVE_TEST_FILE],
      {
        env: {
          ...process.env,
          RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_ARTIFACT: unpacked.artifact,
          RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_EXPECTED_PLATFORM:
            descriptor.platform,
          RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_EXPECTED_ARCHITECTURE:
            descriptor.architecture,
        },
        failureMessage: "unpacked actual native-binding focused test failed",
      },
    );
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await rm(temporaryRoot, { recursive: true, force: false });
  } catch {
    cleanupError = new FoundationError("temporary npm pack cleanup failed");
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new FoundationError(
      `${safeErrorMessage(primaryError)}; cleanup also failed: ${cleanupError.message}`,
    );
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (primaryError !== undefined) throw primaryError;
  process.stdout.write(`verified closed npm pack layout for ${descriptor.target}\n`);
}

function safeErrorMessage(error) {
  return error instanceof FoundationError
    || error instanceof FdOwnedNativeStageError
    || error instanceof NativeTarInspectionError
    ? error.message
    : "explicit native foundation command failed closed";
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const target = parseTargetArgument(args);
  if (command === "stage") {
    await stage(target);
    return;
  }
  if (command === "verify-pack") {
    await verifyPack(target);
    return;
  }
  fail("native foundation command is unsupported");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
