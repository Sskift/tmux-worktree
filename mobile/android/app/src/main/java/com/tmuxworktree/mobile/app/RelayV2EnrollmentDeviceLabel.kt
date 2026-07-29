package com.tmuxworktree.mobile.app

import android.os.Build

/** Platform seam for the stable Android model used by the enrollment product owner. */
internal fun interface RelayV2EnrollmentDeviceLabelSource {
    fun readDeviceModel(): String
}

internal object AndroidRelayV2EnrollmentDeviceLabelSource :
    RelayV2EnrollmentDeviceLabelSource {
    override fun readDeviceModel(): String = Build.MODEL
}

/**
 * Produces the bounded, reviewable label used by one enrollment confirmation.
 *
 * Device models are platform input, so an unusable value falls back to a fixed Android label
 * instead of reaching the frozen HTTPS codec.
 */
internal fun normalizedRelayV2EnrollmentDeviceLabel(deviceModel: String): String {
    val candidate = deviceModel.trim()
    return candidate.takeIf {
        it.isNotEmpty() &&
            it.toByteArray(Charsets.UTF_8).size <= MAX_RELAY_V2_DEVICE_LABEL_BYTES &&
            it.none { character ->
                character == '\u0000' || character == '\r' || character == '\n'
            }
    } ?: DEFAULT_RELAY_V2_DEVICE_LABEL
}

private const val MAX_RELAY_V2_DEVICE_LABEL_BYTES = 128
private const val DEFAULT_RELAY_V2_DEVICE_LABEL = "Android device"
