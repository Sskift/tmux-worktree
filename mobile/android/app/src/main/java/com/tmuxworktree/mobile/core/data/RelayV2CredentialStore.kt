package com.tmuxworktree.mobile.core.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialAttemptKind
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialBlob
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasExpectation
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2PendingCredentialAttempt
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Dedicated Relay v2 namespace; it never reads or rewrites the Relay v1 secret store. */
internal class AndroidKeystoreRelayV2CredentialStore(context: Context) : RelayV2CredentialStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        SECURE_PREFERENCES,
        Context.MODE_PRIVATE,
    )

    override fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob? =
        synchronized(PROCESS_LOCK) { readUnlocked(reference) }

    override fun create(
        reference: RelayV2CredentialReference,
        blob: RelayV2CredentialBlob,
    ): Boolean = synchronized(PROCESS_LOCK) {
        val key = entryKey(reference)
        if (preferences.contains(key)) return@synchronized false
        persist(key, reference, blob)
        true
    }

    override fun compareAndSet(
        reference: RelayV2CredentialReference,
        expectation: RelayV2CredentialCasExpectation,
        replacement: RelayV2CredentialBlob,
    ): RelayV2CredentialCasResult = synchronized(PROCESS_LOCK) {
        val current = readUnlocked(reference)
            ?: return@synchronized RelayV2CredentialCasResult.Stale(null)
        if (current.credentialVersion != expectation.credentialVersion ||
            current.pendingAttempt?.attemptId != expectation.pendingAttemptId ||
            current.pendingAttempt?.secretReference != expectation.pendingSecretReference
        ) {
            return@synchronized RelayV2CredentialCasResult.Stale(current.credentialVersion)
        }
        require(replacement.credentialVersion >= current.credentialVersion) {
            "Credential version cannot move backwards"
        }
        persist(entryKey(reference), reference, replacement)
        RelayV2CredentialCasResult.Updated(replacement.credentialVersion)
    }

    override fun clearIfUnchanged(
        reference: RelayV2CredentialReference,
        expected: RelayV2CredentialBlob,
    ): Boolean = synchronized(PROCESS_LOCK) {
        if (readUnlocked(reference) != expected) return@synchronized false
        check(preferences.edit().remove(entryKey(reference)).commit()) {
            "Relay v2 credential compensation could not be persisted"
        }
        true
    }

    override fun clear(reference: RelayV2CredentialReference) = synchronized(PROCESS_LOCK) {
        check(preferences.edit().remove(entryKey(reference)).commit()) {
            "Relay v2 credential could not be cleared"
        }
    }

    private fun readUnlocked(reference: RelayV2CredentialReference): RelayV2CredentialBlob? {
        val encoded = preferences.getString(entryKey(reference), null) ?: return null
        check(encoded.length <= MAX_ENVELOPE_CHARACTERS) { "Relay v2 credential envelope is oversized" }
        return runCatching {
            val parts = encoded.split(':')
            require(parts.size == 3 && parts[0] == ENVELOPE_VERSION.toString())
            val iv = Base64.decode(parts[1], Base64.NO_WRAP)
            val ciphertext = Base64.decode(parts[2], Base64.NO_WRAP)
            require(iv.size in 12..32 && ciphertext.size <= MAX_CIPHERTEXT_BYTES)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(GCM_TAG_BITS, iv),
            )
            cipher.updateAAD(aad(reference))
            RelayV2CredentialBlobCodec.decode(cipher.doFinal(ciphertext))
        }.getOrElse {
            throw IllegalStateException("Relay v2 credential is unreadable")
        }
    }

    private fun persist(
        key: String,
        reference: RelayV2CredentialReference,
        blob: RelayV2CredentialBlob,
    ) {
        val plaintext = RelayV2CredentialBlobCodec.encode(blob)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        cipher.updateAAD(aad(reference))
        val ciphertext = cipher.doFinal(plaintext)
        val encoded = buildString {
            append(ENVELOPE_VERSION)
            append(':')
            append(Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            append(':')
            append(Base64.encodeToString(ciphertext, Base64.NO_WRAP))
        }
        check(preferences.edit().putString(key, encoded).commit()) {
            "Relay v2 credential could not be persisted"
        }
    }

    private fun aad(reference: RelayV2CredentialReference): ByteArray =
        "tmux-worktree:relay-v2:credential:${reference.value}".toByteArray(Charsets.UTF_8)

    private fun entryKey(reference: RelayV2CredentialReference): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(reference.value.toByteArray(Charsets.UTF_8))
        return "credential_" + Base64.encodeToString(
            digest,
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = loadKeyStore()
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun loadKeyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "tw-mobile-relay-v2-credential-v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val SECURE_PREFERENCES = "tw_mobile_relay_v2_credentials"
        const val ENVELOPE_VERSION = 1
        const val MAX_CIPHERTEXT_BYTES = 262_144
        const val MAX_ENVELOPE_CHARACTERS = 360_000
        val PROCESS_LOCK = Any()
    }
}

/** Versioned, bounded plaintext codec used only before encryption or after authenticated decrypt. */
internal object RelayV2CredentialBlobCodec {
    fun encode(blob: RelayV2CredentialBlob): ByteArray {
        val output = ByteArrayOutputStream()
        DataOutputStream(output).use { data ->
            data.writeInt(blob.schemaVersion)
            data.writeLong(blob.credentialVersion)
            data.writeBoundedString(blob.issuerUrl)
            data.writeBoundedString(blob.relayUrl)
            data.writeBoundedString(blob.hostId)
            data.writeBoundedString(blob.clientInstanceId)
            data.writeNullableString(blob.principalId)
            data.writeNullableString(blob.grantId)
            data.writeNullableString(blob.accessToken)
            data.writeNullableLong(blob.accessExpiresAtMs)
            data.writeNullableString(blob.refreshToken)
            data.writeNullableLong(blob.refreshExpiresAtMs)
            data.writeBoolean(blob.pendingAttempt != null)
            blob.pendingAttempt?.let { pending ->
                data.writeInt(pending.kind.stableStorageTag())
                data.writeBoundedString(pending.attemptId)
                data.writeLong(pending.oldCredentialVersion)
                data.writeBoundedString(pending.secretReference)
                data.writeBoundedString(pending.secret)
                data.writeNullableString(pending.enrollmentId)
                data.writeNullableString(pending.deviceLabel)
            }
        }
        return output.toByteArray().also {
            require(it.size <= MAX_BLOB_BYTES) { "Relay v2 credential blob is oversized" }
        }
    }

    fun decode(bytes: ByteArray): RelayV2CredentialBlob {
        require(bytes.size <= MAX_BLOB_BYTES) { "Relay v2 credential blob is oversized" }
        val input = ByteArrayInputStream(bytes)
        val data = DataInputStream(input)
        val schemaVersion = data.readInt()
        val credentialVersion = data.readLong()
        val issuerUrl = data.readBoundedString()
        val relayUrl = data.readBoundedString()
        val hostId = data.readBoundedString()
        val clientInstanceId = data.readBoundedString()
        val principalId = data.readNullableString()
        val grantId = data.readNullableString()
        val accessToken = data.readNullableString()
        val accessExpiresAtMs = data.readNullableLong()
        val refreshToken = data.readNullableString()
        val refreshExpiresAtMs = data.readNullableLong()
        val pendingAttempt = if (data.readBoolean()) {
            val kind = pendingAttemptKindFromStableStorageTag(data.readInt())
            RelayV2PendingCredentialAttempt(
                kind = kind,
                attemptId = data.readBoundedString(),
                oldCredentialVersion = data.readLong(),
                secretReference = data.readBoundedString(),
                secret = data.readBoundedString(),
                enrollmentId = data.readNullableString(),
                deviceLabel = data.readNullableString(),
            )
        } else {
            null
        }
        require(input.available() == 0) { "Relay v2 credential blob has trailing data" }
        return RelayV2CredentialBlob(
            schemaVersion = schemaVersion,
            credentialVersion = credentialVersion,
            issuerUrl = issuerUrl,
            relayUrl = relayUrl,
            hostId = hostId,
            clientInstanceId = clientInstanceId,
            principalId = principalId,
            grantId = grantId,
            accessToken = accessToken,
            accessExpiresAtMs = accessExpiresAtMs,
            refreshToken = refreshToken,
            refreshExpiresAtMs = refreshExpiresAtMs,
            pendingAttempt = pendingAttempt,
        )
    }

    private fun DataOutputStream.writeBoundedString(value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_STRING_BYTES) { "Relay v2 credential field is oversized" }
        writeInt(bytes.size)
        write(bytes)
    }

    private fun DataOutputStream.writeNullableString(value: String?) {
        writeBoolean(value != null)
        if (value != null) writeBoundedString(value)
    }

    private fun DataOutputStream.writeNullableLong(value: Long?) {
        writeBoolean(value != null)
        if (value != null) writeLong(value)
    }

    private fun DataInputStream.readBoundedString(): String {
        val size = readInt()
        require(size in 0..MAX_STRING_BYTES) { "Relay v2 credential field is oversized" }
        val bytes = ByteArray(size)
        readFully(bytes)
        val value = bytes.toString(Charsets.UTF_8)
        require(value.toByteArray(Charsets.UTF_8).contentEquals(bytes)) {
            "Relay v2 credential field is not valid UTF-8"
        }
        return value
    }

    private fun DataInputStream.readNullableString(): String? =
        if (readBoolean()) readBoundedString() else null

    private fun DataInputStream.readNullableLong(): Long? =
        if (readBoolean()) readLong() else null

    // Frozen within credential schema v1. Never renumber or reuse these tags.
    private fun RelayV2CredentialAttemptKind.stableStorageTag(): Int = when (this) {
        RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE -> PENDING_KIND_ENROLLMENT_EXCHANGE
        RelayV2CredentialAttemptKind.REFRESH -> PENDING_KIND_REFRESH
    }

    private fun pendingAttemptKindFromStableStorageTag(tag: Int): RelayV2CredentialAttemptKind =
        when (tag) {
            PENDING_KIND_ENROLLMENT_EXCHANGE -> RelayV2CredentialAttemptKind.ENROLLMENT_EXCHANGE
            PENDING_KIND_REFRESH -> RelayV2CredentialAttemptKind.REFRESH
            else -> error("Unknown pending credential attempt tag")
        }

    private const val MAX_STRING_BYTES = 65_536
    private const val MAX_BLOB_BYTES = 262_144
    private const val PENDING_KIND_ENROLLMENT_EXCHANGE = 1
    private const val PENDING_KIND_REFRESH = 2
}
