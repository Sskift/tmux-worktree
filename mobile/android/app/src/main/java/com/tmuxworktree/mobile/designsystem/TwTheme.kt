package com.tmuxworktree.mobile.designsystem

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val TwBackground = Color(0xFF070A0E)
val TwSurface = Color(0xFF12161D)
val TwSurfaceRaised = Color(0xFF191E27)
val TwBorder = Color(0xFF2C3440)
val TwTextPrimary = Color(0xFFEDF1F5)
val TwTextSecondary = Color(0xFFA4ACB8)
val TwTextMuted = Color(0xFF67707E)
val TwAccent = Color(0xFFB794F6)
val TwAccentPressed = Color(0xFF8B67D2)
val TwSuccess = Color(0xFF67D584)
val TwWarning = Color(0xFFF2B249)
val TwError = Color(0xFFF76060)
val TwTerminalBackground = Color(0xFF020509)
val TwTerminalText = Color(0xFFD5DAE2)
val TwOnAccent = Color(0xFF090A0F)

private val TwColorScheme = darkColorScheme(
    primary = TwAccent,
    onPrimary = TwOnAccent,
    primaryContainer = TwAccentPressed,
    onPrimaryContainer = TwTextPrimary,
    secondary = TwSuccess,
    onSecondary = TwBackground,
    error = TwError,
    onError = TwBackground,
    background = TwBackground,
    onBackground = TwTextPrimary,
    surface = TwSurface,
    onSurface = TwTextPrimary,
    surfaceVariant = TwSurfaceRaised,
    onSurfaceVariant = TwTextSecondary,
    outline = TwBorder,
)

val TwTypography = Typography(
    headlineLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 28.sp,
        lineHeight = 34.sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 24.sp,
        lineHeight = 30.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 20.sp,
        lineHeight = 26.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 18.sp,
        lineHeight = 24.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
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
        fontSize = 15.sp,
        lineHeight = 20.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
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
fun TwTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = TwColorScheme,
        typography = TwTypography,
        shapes = TwShapes,
        content = content,
    )
}
