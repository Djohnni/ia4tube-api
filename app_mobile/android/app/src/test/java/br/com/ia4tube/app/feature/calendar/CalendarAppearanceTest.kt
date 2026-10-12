package br.com.ia4tube.app.feature.calendar

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import org.junit.Assert.*
import org.junit.Test

internal fun calendarAppearanceTestSchemes(): Map<String, ColorScheme> = buildMap {
    mapOf("light" to lightColorScheme(), "dark" to darkColorScheme()).forEach { (name, base) ->
        put(name, base)
        // Match the premium shell's partial palette overrides, retaining the dark containers.
        mapOf(
            "cream" to listOf(0xFFFFFBF2, 0xFFF4E6C6, 0xFFC9952E),
            "blue" to listOf(0xFFEAF2FF, 0xFFD7E7FF, 0xFF2563EB),
            "pink" to listOf(0xFFFFEAF4, 0xFFFFD6EA, 0xFFC02672),
            "gold" to listOf(0xFFFFF6DE, 0xFFF1DFC0, 0xFFC9952E)
        ).forEach { (palette, values) ->
            put("$palette-$name", base.copy(
                surface = Color(values[0]), surfaceVariant = Color(values[1]), primary = Color(values[2]),
                onSurface = Color(0xFF111827), onSurfaceVariant = Color(0xFF4B5563)
            ))
        }
    }
}

class CalendarAppearanceTest {
    @Test fun everyLocalTextRoleRemainsReadableWithoutChangingTheAppScheme() {
        calendarAppearanceTestSchemes().forEach { (name, scheme) ->
            val before = listOf(scheme.surface, scheme.surfaceContainerHigh, scheme.onSurface, scheme.primary, scheme.error)
            val appearance = calendarAppearance(scheme)
            assertEquals(before, listOf(scheme.surface, scheme.surfaceContainerHigh, scheme.onSurface, scheme.primary, scheme.error))
            assertEquals(scheme.surface, appearance.surface)
            listOf(appearance.content, appearance.secondary, appearance.action, appearance.error).forEach { color ->
                assertTrue("$name: text must reach 4.5:1 on its actual local surface",
                    calendarContrastRatio(color, appearance.surface) >= 4.5f)
            }
        }
    }

    @Test fun premiumOverDarkRegressionUsesSurfaceInsteadOfInheritedDarkContainer() {
        val scheme = calendarAppearanceTestSchemes().getValue("gold-dark")
        assertTrue(calendarContrastRatio(scheme.onSurface, scheme.surfaceContainerHigh) < 4.5f)
        val appearance = calendarAppearance(scheme)
        assertEquals(scheme.onSurface, appearance.content)
        assertTrue(calendarContrastRatio(appearance.content, appearance.surface) >= 4.5f)
        assertNotEquals(scheme.surfaceContainerHigh, appearance.surface)
    }
}
