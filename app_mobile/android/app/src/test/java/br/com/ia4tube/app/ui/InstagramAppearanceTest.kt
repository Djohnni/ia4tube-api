package br.com.ia4tube.app.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import br.com.ia4tube.app.feature.instagram.instagramContrastRatio
import br.com.ia4tube.app.feature.instagram.instagramReadableForeground
import br.com.ia4tube.app.feature.instagram.instagramUsesStackedHeader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InstagramAppearanceTest {
    @Test fun controlsRemainReadableAcrossSupportedPalettesAndSystemThemes() {
        supportedSchemes().forEach { (name, scheme) ->
            assertReadable("$name card", scheme.onSurface, scheme.surface)
            assertReadable("$name secondary and outlined action", scheme.onSurfaceVariant, scheme.surface)
            assertReadable("$name filled action", scheme.onPrimary, scheme.primary)
            assertReadable("$name disabled action", scheme.onSurfaceVariant, scheme.surfaceVariant)
            assertReadable("$name error", scheme.onErrorContainer, scheme.errorContainer)
            // The same outlined action also appears above the cards.
            val actionText = instagramReadableForeground(scheme.onSurface, scheme.surface)
            assertTrue("$name action on screen background",
                instagramContrastRatio(actionText, scheme.background) >= 4.5f)
        }
    }

    @Test fun premiumOverDarkRegressionRequiresExplicitSurfaceAndForegroundPairs() {
        val scheme = supportedSchemes().getValue("blue / dark")
        assertTrue(instagramContrastRatio(scheme.onSurface, scheme.surfaceContainerHighest) < 4.5f)
        assertTrue(instagramContrastRatio(scheme.onSurface, scheme.surface) >= 4.5f)
        assertTrue(instagramContrastRatio(scheme.onPrimary, scheme.primary) < 4.5f)
        assertEquals(Color.White, instagramReadableForeground(scheme.onPrimary, scheme.primary))
    }

    @Test fun aReadablePaletteForegroundIsPreserved() {
        val paletteText = Color(0xFF111827)
        assertEquals(paletteText, instagramReadableForeground(paletteText, Color(0xFFFFFBF2)))
        assertEquals(Color.Black, instagramReadableForeground(Color.White, Color(0xFFFFFBF2)))
    }

    @Test fun narrowScreensAndEnlargedFontsKeepTheBackActionBelowTheTitle() {
        listOf(
            Triple(359f, 1.0f, true),
            Triple(360f, 1.0f, false),
            Triple(360f, 1.29f, false),
            Triple(359f, 1.3f, true),
            Triple(360f, 1.3f, true),
            Triple(359f, 2.0f, true),
            Triple(360f, 2.0f, true),
            Triple(840f, 2.0f, true)
        ).forEach { (width, fontScale, stacked) ->
            assertEquals("width=$width, fontScale=$fontScale", stacked,
                instagramUsesStackedHeader(width, fontScale))
        }
    }

    private fun assertReadable(label: String, preferred: Color, background: Color) {
        val foreground = instagramReadableForeground(preferred, background)
        assertTrue(label, instagramContrastRatio(foreground, background) >= 4.5f)
    }

    // Controlled fixtures for the palette overrides in IA4TubeNavHost; no network or Android UI is started.
    private fun supportedSchemes(): Map<String, ColorScheme> {
        val bases = mapOf(
            "light" to lightColorScheme(
                primary = Color(0xFF16A34A), onPrimary = Color.White,
                background = Color(0xFFF8FAFC), surface = Color.White,
                onSurface = Color(0xFF0F172A)
            ),
            "dark" to darkColorScheme(
                primary = Color(0xFF22C55E), onPrimary = Color(0xFF052E16),
                background = Color(0xFF0F172A), surface = Color(0xFF111827),
                onSurface = Color(0xFFE5E7EB)
            )
        )
        val palettes = mapOf(
            "cream" to listOf(0xFFFBF7EF, 0xFFFFFBF2, 0xFFF4E6C6, 0xFFC9952E),
            "blue" to listOf(0xFFF3F7FF, 0xFFEAF2FF, 0xFFD7E7FF, 0xFF2563EB),
            "pink" to listOf(0xFFFFF5FA, 0xFFFFEAF4, 0xFFFFD6EA, 0xFFC02672),
            "gold" to listOf(0xFFF7F3EA, 0xFFFFF6DE, 0xFFF1DFC0, 0xFFC9952E)
        )
        return buildMap {
            bases.forEach { (theme, base) ->
                put("base / $theme", base)
                palettes.forEach { (palette, values) ->
                    put("$palette / $theme", base.copy(
                        background = Color(values[0]), surface = Color(values[1]),
                        surfaceVariant = Color(values[2]), primary = Color(values[3]),
                        onPrimary = Color(0xFF11100A), onSurface = Color(0xFF111827),
                        onSurfaceVariant = Color(0xFF4B5563)
                    ))
                }
            }
        }
    }
}
