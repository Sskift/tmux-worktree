package com.tmuxworktree.mobile.core.terminal

/**
 * Mouse and focus reports describe the read-only terminal attachment. They are not pane text and
 * must never enter Relay's controlled input lane.
 */
internal fun isControlledTerminalTransportReport(data: String): Boolean =
    CONTROLLED_TERMINAL_TRANSPORT_REPORT.matches(data)

/**
 * Prevents the read-only tmux attachment from enabling xterm mouse/focus reports. The filter keeps
 * an incomplete CSI sequence across output chunks because terminal output is not frame aligned.
 */
internal class ControlledTerminalOutputFilter {
    private var pending: String = ""
    private var discardingOversizedPrivateCsi: Boolean = false

    fun push(data: String): String {
        var dataIndex = 0
        if (discardingOversizedPrivateCsi) {
            while (dataIndex < data.length && (data[dataIndex].isDigit() || data[dataIndex] == ';')) {
                dataIndex += 1
            }
            if (dataIndex >= data.length) return ""
            dataIndex += 1
            discardingOversizedPrivateCsi = false
        }

        val input = pending + data.substring(dataIndex)
        pending = ""
        val output = StringBuilder(input.length)
        var index = 0
        while (index < input.length) {
            val start = input.indexOf(ESCAPE, index)
            if (start < 0) {
                output.append(input, index, input.length)
                break
            }
            output.append(input, index, start)
            if (start + 1 >= input.length) {
                pending = input.substring(start)
                break
            }
            if (input[start + 1] != '[') {
                output.append(ESCAPE)
                index = start + 1
                continue
            }
            if (start + 2 >= input.length) {
                pending = input.substring(start)
                break
            }
            if (input[start + 2] != '?') {
                output.append("\u001B[")
                index = start + 2
                continue
            }

            var finalIndex = start + 3
            while (finalIndex < input.length && (input[finalIndex].isDigit() || input[finalIndex] == ';')) {
                finalIndex += 1
            }
            if (finalIndex >= input.length) {
                val candidate = input.substring(start)
                if (candidate.length <= MAX_PENDING_PRIVATE_CSI_CHARS) {
                    pending = candidate
                } else {
                    discardingOversizedPrivateCsi = true
                }
                break
            }
            val final = input[finalIndex]
            if (final != 'h') {
                output.append(input, start, finalIndex + 1)
                index = finalIndex + 1
                continue
            }
            val rawParameters = input.substring(start + 3, finalIndex)
            if (rawParameters.isEmpty()) {
                output.append(input, start, finalIndex + 1)
                index = finalIndex + 1
                continue
            }
            val retained = rawParameters
                .split(';')
                .filter { it.isNotEmpty() && it !in CONTROLLED_MOUSE_MODES }
            if (retained.isNotEmpty()) {
                output.append("\u001B[?")
                output.append(retained.joinToString(";"))
                output.append('h')
            }
            index = finalIndex + 1
        }
        return output.toString()
    }

    fun reset() {
        pending = ""
        discardingOversizedPrivateCsi = false
    }
}

private const val ESCAPE = '\u001B'
private const val MAX_PENDING_PRIVATE_CSI_CHARS = 256

private val CONTROLLED_TERMINAL_TRANSPORT_REPORT = Regex(
    "^(?:(?:${ESCAPE}\\[<\\d+;\\d+;\\d+[mM])|" +
        "(?:${ESCAPE}\\[\\d+;\\d+;\\d+M)|" +
        "(?:${ESCAPE}\\[M[\\s\\S]{3})|" +
        "(?:${ESCAPE}\\[[IO]))+$",
)

private val CONTROLLED_MOUSE_MODES = setOf(
    "9",
    "1000",
    "1002",
    "1003",
    "1004",
    "1005",
    "1006",
    "1015",
    "1016",
)
