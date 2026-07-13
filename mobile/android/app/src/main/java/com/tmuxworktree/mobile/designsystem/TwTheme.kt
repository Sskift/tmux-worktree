package com.tmuxworktree.mobile.designsystem

import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private data class TwPalette(
    val background: Color,
    val surface: Color,
    val surfaceRaised: Color,
    val border: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    val accent: Color,
    val accentPressed: Color,
    val success: Color,
    val warning: Color,
    val error: Color,
    val terminalBackground: Color,
    val terminalText: Color,
    val onAccent: Color,
)

private val DarkPalette = TwPalette(
    background = Color(0xFF070A0E),
    surface = Color(0xFF12161D),
    surfaceRaised = Color(0xFF191E27),
    border = Color(0xFF2C3440),
    textPrimary = Color(0xFFEDF1F5),
    textSecondary = Color(0xFFA4ACB8),
    textMuted = Color(0xFF67707E),
    accent = Color(0xFFB794F6),
    accentPressed = Color(0xFF8B67D2),
    success = Color(0xFF67D584),
    warning = Color(0xFFF2B249),
    error = Color(0xFFF76060),
    terminalBackground = Color(0xFF020509),
    terminalText = Color(0xFFD5DAE2),
    onAccent = Color(0xFF090A0F),
)

private val LightPalette = TwPalette(
    background = Color(0xFFF6F7F9),
    surface = Color(0xFFFFFFFF),
    surfaceRaised = Color(0xFFEEF1F5),
    border = Color(0xFFD5DBE5),
    textPrimary = Color(0xFF1B222C),
    textSecondary = Color(0xFF596575),
    textMuted = Color(0xFF7A8696),
    accent = Color(0xFF7044B8),
    accentPressed = Color(0xFF57348F),
    success = Color(0xFF197A40),
    warning = Color(0xFF9A5D00),
    error = Color(0xFFC43B3B),
    terminalBackground = Color(0xFF020509),
    terminalText = Color(0xFFD5DAE2),
    onAccent = Color(0xFFFFFFFF),
)

private val LocalTwPalette = staticCompositionLocalOf { DarkPalette }

val TwBackground: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.background

val TwSurface: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.surface

val TwSurfaceRaised: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.surfaceRaised

val TwBorder: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.border

val TwTextPrimary: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.textPrimary

val TwTextSecondary: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.textSecondary

val TwTextMuted: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.textMuted

val TwAccent: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.accent

val TwAccentPressed: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.accentPressed

val TwSuccess: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.success

val TwWarning: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.warning

val TwError: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.error

val TwTerminalBackground: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.terminalBackground

val TwTerminalText: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.terminalText

val TwOnAccent: Color
    @Composable
    @ReadOnlyComposable
    get() = LocalTwPalette.current.onAccent

val TwTypography = Typography(
    headlineLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 26.sp,
        lineHeight = 32.sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 18.sp,
        lineHeight = 24.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 23.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 18.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    ),
)

private val TwShapes = Shapes(
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
)

@Composable
fun TwTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit,
) {
    val palette = if (darkTheme) DarkPalette else LightPalette
    val colorScheme = if (darkTheme) {
        darkColorScheme(
            primary = palette.accent,
            onPrimary = palette.onAccent,
            primaryContainer = palette.accentPressed,
            onPrimaryContainer = palette.textPrimary,
            secondary = palette.success,
            onSecondary = palette.background,
            error = palette.error,
            onError = palette.background,
            background = palette.background,
            onBackground = palette.textPrimary,
            surface = palette.surface,
            onSurface = palette.textPrimary,
            surfaceVariant = palette.surfaceRaised,
            onSurfaceVariant = palette.textSecondary,
            outline = palette.border,
        )
    } else {
        lightColorScheme(
            primary = palette.accent,
            onPrimary = palette.onAccent,
            primaryContainer = palette.accentPressed,
            onPrimaryContainer = palette.onAccent,
            secondary = palette.success,
            onSecondary = palette.onAccent,
            error = palette.error,
            onError = palette.onAccent,
            background = palette.background,
            onBackground = palette.textPrimary,
            surface = palette.surface,
            onSurface = palette.textPrimary,
            surfaceVariant = palette.surfaceRaised,
            onSurfaceVariant = palette.textSecondary,
            outline = palette.border,
        )
    }
    val activity = LocalActivity.current as? ComponentActivity
    SideEffect {
        activity?.enableEdgeToEdge(
            statusBarStyle = if (darkTheme) {
                SystemBarStyle.dark(AndroidColor.TRANSPARENT)
            } else {
                SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
            },
            navigationBarStyle = if (darkTheme) {
                SystemBarStyle.dark(AndroidColor.TRANSPARENT)
            } else {
                SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
            },
        )
    }

    CompositionLocalProvider(LocalTwPalette provides palette) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = TwTypography,
            shapes = TwShapes,
            content = content,
        )
    }
}
