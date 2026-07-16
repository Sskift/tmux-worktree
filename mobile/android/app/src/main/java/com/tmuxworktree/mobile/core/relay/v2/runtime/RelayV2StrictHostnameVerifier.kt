package com.tmuxworktree.mobile.core.relay.v2.runtime

import java.net.InetAddress
import java.security.cert.CertificateParsingException
import java.security.cert.X509Certificate
import java.util.Locale
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSession

/**
 * Process-local RFC 2818 verifier that cannot be replaced through
 * HttpsURLConnection.setDefaultHostnameVerifier(). Only DNS/IP subjectAltName entries are
 * accepted; the deprecated common-name fallback is deliberately unsupported.
 */
internal object RelayV2StrictHostnameVerifier : HostnameVerifier {
    override fun verify(hostname: String, session: SSLSession): Boolean {
        val certificate = try {
            session.peerCertificates.firstOrNull() as? X509Certificate
        } catch (_: SSLException) {
            null
        } ?: return false
        return verify(hostname, certificate)
    }

    internal fun verify(hostname: String, certificate: X509Certificate): Boolean {
        if (!hostname.isPrintableAscii()) return false
        return if (hostname.isNumericAddress()) {
            val expected = hostname.numericAddressBytes() ?: return false
            certificate.subjectAltNames(SUBJECT_ALT_IP).any { candidate ->
                candidate.numericAddressBytes()?.contentEquals(expected) == true
            }
        } else {
            val normalized = hostname.normalizedDnsName() ?: return false
            certificate.subjectAltNames(SUBJECT_ALT_DNS).any { candidate ->
                matchesDnsName(normalized, candidate)
            }
        }
    }

    private fun matchesDnsName(hostname: String, certificateName: String): Boolean {
        if (!certificateName.isPrintableAscii()) return false
        val pattern = certificateName.normalizedDnsName(allowWildcard = true) ?: return false
        if ('*' !in pattern) return hostname == pattern
        if (!pattern.startsWith("*.") || pattern.indexOf('*', startIndex = 1) != -1) return false

        val suffix = pattern.substring(2)
        // Reject a wildcard directly below a public-looking top-level label such as *.com.
        if (suffix.count { it == '.' } < 2) return false
        if (!hostname.endsWith(suffix)) return false
        val wildcardLabel = hostname.dropLast(suffix.length)
        return wildcardLabel.isNotEmpty() && wildcardLabel.endsWith('.') &&
            '.' !in wildcardLabel.dropLast(1)
    }

    private fun X509Certificate.subjectAltNames(type: Int): List<String> = try {
        subjectAlternativeNames.orEmpty().mapNotNull { entry ->
            if (entry.size >= 2 && entry[0] == type) entry[1] as? String else null
        }
    } catch (_: CertificateParsingException) {
        emptyList()
    } catch (_: RuntimeException) {
        emptyList()
    }

    private fun String.normalizedDnsName(allowWildcard: Boolean = false): String? {
        if (isEmpty() || startsWith('.') || endsWith("..")) return null
        val absolute = if (endsWith('.')) this else "$this."
        val labels = absolute.dropLast(1).split('.')
        if (labels.any { it.isEmpty() || it.length > 63 }) return null
        if (labels.any { label ->
                label.first() == '-' || label.last() == '-' ||
                    label.any { character ->
                        !(character in 'a'..'z' || character in 'A'..'Z' ||
                            character in '0'..'9' || character == '-' ||
                            allowWildcard && character == '*')
                    }
            }
        ) {
            return null
        }
        return absolute.lowercase(Locale.US)
    }

    private fun String.isPrintableAscii(): Boolean = isNotEmpty() && all { it in ' '..'~' }

    private fun String.isNumericAddress(): Boolean = ':' in this || all { it in '0'..'9' || it == '.' }

    private fun String.numericAddressBytes(): ByteArray? {
        if (!isNumericAddress()) return null
        if (':' !in this) {
            val pieces = split('.')
            if (pieces.size != 4 || pieces.any { piece ->
                    piece.isEmpty() || piece.length > 3 || piece.any { it !in '0'..'9' } ||
                        piece.toIntOrNull() !in 0..255
                }
            ) {
                return null
            }
        }
        return runCatching { InetAddress.getByName(this).address }.getOrNull()
    }

    private const val SUBJECT_ALT_DNS = 2
    private const val SUBJECT_ALT_IP = 7
}
