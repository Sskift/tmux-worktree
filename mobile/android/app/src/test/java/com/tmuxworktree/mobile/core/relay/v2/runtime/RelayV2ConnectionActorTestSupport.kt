package com.tmuxworktree.mobile.core.relay.v2.runtime

/**
 * F054: Companion constants extracted from RelayV2ConnectionActorTest so the
 * test class body only holds tests and fakes. Inner classes (Harness,
 * FakeTransport, etc.) are intentionally left in the test file.
 *
 * Note: other test classes in this package (BaseRuntimeCompositionTest,
 * OutboxQueryAdmissionAdapterTest, TerminalControlCodecBridgeTest) define
 * their own same-named constants in companion objects with different values
 * (notably NOW_MS). Those companion constants shadow these top-level ones
 * within their respective classes, so do not remove those companions without
 * reconciling the values.
 */
internal const val TIMEOUT_MS = 5_000L
internal const val NOW_MS = 1_000_000L
internal const val HOST_ID = "mac-admin"
internal const val PRINCIPAL_ID = "principal-opaque-id"
internal const val HOST_EPOCH = "authority-uuid"
