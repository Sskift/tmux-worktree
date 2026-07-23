package com.tmuxworktree.mobile.core.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialInstall
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCredentialReferenceIndex
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialOwner
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialStore
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Dedicated encrypted terminal-token namespace; no token is stored in Room or profile state. */
internal class AndroidKeystoreRelayV2TerminalResumeCredentialStore(
    context: Context,
) : RelayV2TerminalResumeCredentialStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        SECURE_PREFERENCES,
        Context.MODE_PRIVATE,
    )
    private val referenceIndex = RelayV2TerminalCredentialReferenceIndex(::digest)

    override fun installExact(
        owner: RelayV2TerminalResumeCredentialOwner,
        reference: String,
        resumeToken: String,
    ): RelayV2TerminalResumeCredentialInstall? = synchronized(PROCESS_LOCK) {
        requireReference(reference)
        requireToken(resumeToken)
        val fingerprint = fingerprint(resumeToken)
        val indexKey = referenceIndex.key(owner)
        val indexed = readIndex(indexKey)
        val current = readUnlocked(owner, reference)
        if (current != null) {
            if (!MessageDigest.isEqual(
                    current.toByteArray(Charsets.UTF_8),
                    resumeToken.toByteArray(Charsets.UTF_8),
                )
            ) return@synchronized null
            if (reference !in indexed) {
                check(indexed.size < MAX_REFERENCES_PER_ACTIVATION) {
                    "Relay v2 terminal credential index is full"
                }
                check(preferences.edit().putStringSet(indexKey, indexed + reference).commit()) {
                    "Relay v2 terminal credential index could not be repaired"
                }
            }
            return@synchronized RelayV2TerminalResumeCredentialInstall(
                fingerprint,
                created = false,
            )
        }
        check(indexed.size < MAX_REFERENCES_PER_ACTIVATION) {
            "Relay v2 terminal credential index is full"
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        cipher.updateAAD(aad(owner, reference))
        val ciphertext = cipher.doFinal(resumeToken.toByteArray(Charsets.UTF_8))
        val envelope = listOf(
            ENVELOPE_VERSION.toString(),
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            Base64.encodeToString(ciphertext, Base64.NO_WRAP),
        ).joinToString(":")
        check(
            preferences.edit()
                .putString(referenceIndex.entryKey(owner, reference), envelope)
                .putStringSet(indexKey, indexed + reference)
                .commit(),
        ) {
            "Relay v2 terminal credential could not be persisted"
        }
        RelayV2TerminalResumeCredentialInstall(fingerprint, created = true)
    }

    override fun read(
        owner: RelayV2TerminalResumeCredentialOwner,
        reference: String,
    ): String? = synchronized(PROCESS_LOCK) {
        requireReference(reference)
        readUnlocked(owner, reference)
    }

    override fun clear(
        owner: RelayV2TerminalResumeCredentialOwner,
        reference: String,
    ) = synchronized(PROCESS_LOCK) {
        requireReference(reference)
        val indexKey = referenceIndex.key(owner)
        val remaining = readIndex(indexKey) - reference
        val editor = preferences.edit().remove(referenceIndex.entryKey(owner, reference))
        if (remaining.isEmpty()) editor.remove(indexKey)
        else editor.putStringSet(indexKey, remaining)
        check(editor.commit()) {
            "Relay v2 terminal credential could not be cleared"
        }
    }

    override fun clearProfile(
        profileId: String,
        throughActivationGeneration: Long,
    ) = synchronized(PROCESS_LOCK) {
        require(profileId.isNotBlank() && throughActivationGeneration > 0)
        val editor = preferences.edit()
        referenceIndex.clearPlan(
            profileId,
            throughActivationGeneration,
            preferences.all,
        ).forEach { indexed ->
            indexed.references.forEach { reference ->
                editor.remove(referenceIndex.entryKey(indexed.owner, reference))
            }
            editor.remove(indexed.indexKey)
        }
        check(editor.commit()) {
            "Relay v2 terminal profile credentials could not be cleared"
        }
    }

    private fun readUnlocked(
        owner: RelayV2TerminalResumeCredentialOwner,
        reference: String,
    ): String? {
        val envelope = preferences.getString(
            referenceIndex.entryKey(owner, reference),
            null,
        ) ?: return null
        return runCatching {
            require(envelope.length <= MAX_ENVELOPE_CHARS)
            val parts = envelope.split(':')
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
            cipher.updateAAD(aad(owner, reference))
            cipher.doFinal(ciphertext).toString(Charsets.UTF_8).also(::requireToken)
        }.getOrElse {
            throw IllegalStateException("Relay v2 terminal credential is unreadable")
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
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

    private fun aad(
        owner: RelayV2TerminalResumeCredentialOwner,
        reference: String,
    ): ByteArray = listOf(
        "tmux-worktree:relay-v2:terminal",
        owner.profileId,
        owner.profileActivationGeneration.toString(),
        reference,
    ).joinToString("\u0000").toByteArray(Charsets.UTF_8)

    private fun readIndex(key: String): Set<String> {
        return referenceIndex.references(preferences.all[key])
    }

    private fun fingerprint(token: String): String = digest(token)

    private fun digest(value: String): String = Base64.encodeToString(
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)),
        Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
    )

    private fun requireReference(reference: String) {
        require(reference.isNotBlank() && reference.toByteArray(Charsets.UTF_8).size <= 256)
    }

    private fun requireToken(token: String) {
        require(token.isNotBlank() && token.toByteArray(Charsets.UTF_8).size <= 4_096)
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "tw-mobile-relay-v2-terminal-resume-v1"
        const val SECURE_PREFERENCES = "tw_mobile_relay_v2_terminal_credentials"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val ENVELOPE_VERSION = 2
        const val MAX_CIPHERTEXT_BYTES = 8_192
        const val MAX_ENVELOPE_CHARS = 16_384
        const val MAX_REFERENCES_PER_ACTIVATION = 64
        val PROCESS_LOCK = Any()
    }
}
