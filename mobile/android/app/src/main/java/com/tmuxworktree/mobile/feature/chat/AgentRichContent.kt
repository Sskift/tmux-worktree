package com.tmuxworktree.mobile.feature.chat

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatContentPart
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatImagePart
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatMarkdownPart
import com.tmuxworktree.mobile.core.relay.runtime.RelayChatImageState
import com.tmuxworktree.mobile.core.relay.runtime.RelayChatState
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwBorder
import com.tmuxworktree.mobile.designsystem.TwSurface
import com.tmuxworktree.mobile.designsystem.TwTextMuted
import com.tmuxworktree.mobile.designsystem.TwTextPrimary
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image as MarkdownImage
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MarkdownText
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

private val markdownParser = Parser.builder().build()

private data class MarkdownColors(
    val accent: Color,
    val muted: Color,
    val surface: Color,
)

@Composable
internal fun AgentRichContent(
    content: List<AgentChatContentPart>,
    chatState: RelayChatState,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        content.forEach { part ->
            when (part) {
                is AgentChatMarkdownPart -> MarkdownTextContent(part.text)
                is AgentChatImagePart -> AgentOutputImage(part, chatState.image(part.imageId))
            }
        }
    }
}

@Composable
private fun MarkdownTextContent(source: String) {
    val colors = MarkdownColors(accent = TwAccent, muted = TwTextMuted, surface = TwSurface)
    val rendered = remember(source, colors) {
        val builder = AnnotatedString.Builder()
        renderBlocks(markdownParser.parse(source), builder, colors)
        val value = builder.toAnnotatedString()
        var end = value.length
        while (end > 0 && value[end - 1].isWhitespace()) end -= 1
        value.subSequence(0, end)
    }
    if (rendered.isNotEmpty()) {
        Text(
            text = rendered,
            color = TwTextPrimary,
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}

private fun renderBlocks(
    parent: Node,
    builder: AnnotatedString.Builder,
    colors: MarkdownColors,
) {
    var node = parent.firstChild
    while (node != null) {
        when (node) {
            is Heading -> {
                builder.withStyle(
                    SpanStyle(
                        fontWeight = FontWeight.Bold,
                        fontSize = if (node.level <= 2) 20.sp else 17.sp,
                    ),
                ) { renderInlineChildren(node, this, colors) }
                builder.append("\n\n")
            }
            is Paragraph -> {
                renderInlineChildren(node, builder, colors)
                builder.append("\n\n")
            }
            is FencedCodeBlock -> appendCodeBlock(builder, node.literal, colors)
            is IndentedCodeBlock -> appendCodeBlock(builder, node.literal, colors)
            is BulletList -> renderList(node, builder, ordered = false, colors = colors)
            is OrderedList -> renderList(node, builder, ordered = true, colors = colors)
            is BlockQuote -> {
                builder.withStyle(SpanStyle(color = colors.muted, fontStyle = FontStyle.Italic)) {
                    append("│ ")
                    renderBlocks(node, this, colors)
                }
            }
            is ThematicBreak -> builder.append("────────\n\n")
            else -> renderBlocks(node, builder, colors)
        }
        node = node.next
    }
}

private fun appendCodeBlock(
    builder: AnnotatedString.Builder,
    literal: String,
    colors: MarkdownColors,
) {
    builder.withStyle(
        SpanStyle(
            fontFamily = FontFamily.Monospace,
            background = colors.surface,
        ),
    ) {
        append(literal.trimEnd())
    }
    builder.append("\n\n")
}

private fun renderList(
    list: Node,
    builder: AnnotatedString.Builder,
    ordered: Boolean,
    colors: MarkdownColors,
) {
    var item = list.firstChild
    var number = (list as? OrderedList)?.markerStartNumber ?: 1
    while (item != null) {
        if (item is ListItem) {
            builder.append(if (ordered) "${number++}. " else "• ")
            var child = item.firstChild
            while (child != null) {
                if (child is Paragraph) renderInlineChildren(child, builder, colors)
                else renderBlocks(child, builder, colors)
                child = child.next
            }
            builder.append("\n")
        }
        item = item.next
    }
    builder.append("\n")
}

private fun renderInlineChildren(
    parent: Node,
    builder: AnnotatedString.Builder,
    colors: MarkdownColors,
) {
    var node = parent.firstChild
    while (node != null) {
        when (node) {
            is MarkdownText -> builder.append(node.literal)
            is SoftLineBreak -> builder.append(" ")
            is HardLineBreak -> builder.append("\n")
            is Emphasis -> builder.withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
                renderInlineChildren(node, this, colors)
            }
            is StrongEmphasis -> builder.withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
                renderInlineChildren(node, this, colors)
            }
            is Code -> builder.withStyle(
                SpanStyle(fontFamily = FontFamily.Monospace, background = colors.surface),
            ) { append(node.literal) }
            is Link -> builder.withStyle(
                SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline),
            ) { renderInlineChildren(node, this, colors) }
            is MarkdownImage -> {
                builder.withStyle(SpanStyle(color = colors.muted, fontStyle = FontStyle.Italic)) {
                    append("[image: ")
                    renderInlineChildren(node, this, colors)
                    append("]")
                }
            }
            is HtmlInline -> builder.append(node.literal)
            else -> renderInlineChildren(node, builder, colors)
        }
        node = node.next
    }
}

@Composable
private fun AgentOutputImage(part: AgentChatImagePart, state: RelayChatImageState?) {
    val bitmap = remember(state?.bytes, state?.complete) {
        state?.takeIf { it.complete }?.bytes?.let { bytes ->
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }
    }
    when {
        state?.error != null -> Text(
            text = state.error,
            color = TwTextMuted,
            style = MaterialTheme.typography.bodySmall,
        )
        bitmap != null -> Image(
            bitmap = bitmap,
            contentDescription = part.altText.ifEmpty { "Agent image" },
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 320.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(TwSurface),
        )
        else -> Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(TwSurface)
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = TwAccent,
                trackColor = TwBorder,
            )
            Text(
                text = part.altText.ifEmpty { "Loading image…" },
                color = TwTextMuted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
