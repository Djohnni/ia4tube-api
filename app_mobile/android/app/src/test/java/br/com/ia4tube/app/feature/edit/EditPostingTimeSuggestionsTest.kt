package br.com.ia4tube.app.feature.edit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime

class EditPostingTimeSuggestionsTest {
    @Test fun accentedCapitalizedAndPunctuatedBusinessTypesAreRecognized() {
        val burger = editPostingTimeCategory("HAMBÚRGUER ARTESANAL / DELIVERY")
        assertEquals("Hamburguerias e pizzarias", burger.label)
        assertEquals(listOf(LocalTime.of(18, 0), LocalTime.of(11, 30)), burger.slots.map { it.time })
        assertEquals("Beleza", editPostingTimeCategory("  SALÃO DE BELEZA  ").label)
        assertEquals("Comércio", editPostingTimeCategory("Materiais de Construção").label)
        assertEquals("Restaurantes", editPostingTimeCategory("Self-service").label)
    }

    @Test fun categoriesReflectDifferentBusinessContexts() {
        val expected = mapOf(
            "Pizzaria" to ("Hamburguerias e pizzarias" to listOf("18:00", "11:30")),
            "Marmitaria" to ("Restaurantes" to listOf("11:00", "18:00")),
            "Padaria" to ("Padarias e cafés" to listOf("07:00", "15:00")),
            "Cafeteria" to ("Padarias e cafés" to listOf("07:00", "15:00")),
            "Barbearia" to ("Beleza" to listOf("12:00", "18:00")),
            "Academia" to ("Academias" to listOf("07:00", "18:00")),
            "Loja de roupas" to ("Comércio" to listOf("09:00", "12:00")),
            "Pet shop" to ("Comércio" to listOf("09:00", "12:00")),
        )
        expected.forEach { (businessType, category) ->
            val actual = editPostingTimeCategory(businessType)
            assertEquals(businessType, category.first, actual.label)
            assertEquals(businessType, category.second.map(LocalTime::parse), actual.slots.map { it.time })
        }
    }

    @Test fun matchingUsesCompleteWordsInsteadOfFragments() {
        assertEquals("Padarias e cafés", editPostingTimeCategory("Pão artesanal").label)
        assertEquals("Sugestões gerais", editPostingTimeCategory("Distribuidora de papelão").label)
        assertEquals("Sugestões gerais", editPostingTimeCategory("Consultoria em cafeicultura").label)
        assertEquals("Comércio", editPostingTimeCategory("Loja de papelão").label)
    }

    @Test fun aSpecificFoodTypeTakesPrecedenceOverBroadCommerceTerms() {
        assertEquals("Hamburguerias e pizzarias", editPostingTimeCategory("Loja de hambúrgueres").label)
        assertEquals("Hamburguerias e pizzarias", editPostingTimeCategory("Restaurante e pizzaria").label)
        assertEquals("Padarias e cafés", editPostingTimeCategory("Loja de pães").label)
    }

    @Test fun missingOrUnknownBusinessTypesHaveHonestGeneralSuggestions() {
        val general = editPostingTimeCategory("")
        assertEquals("Sugestões gerais", general.label)
        assertEquals(listOf(LocalTime.of(12, 0), LocalTime.of(18, 0)), general.slots.map { it.time })
        assertEquals(general, editPostingTimeCategory("   "))
        assertEquals(general, editPostingTimeCategory("Engenharia de software"))
        assertEquals(general, editPostingTimeCategory("Delivery"))
        assertEquals("Comércio", editPostingTimeCategory("Pet shop com delivery").label)
    }

    @Test fun firstTwoDaysUseTheRequestedEveningRanges() {
        assertEquals(EditPostingTimeWindow(LocalTime.of(17, 55), LocalTime.of(18, 5)),
            editPostingTimeWindow(LocalTime.of(18, 0), LocalDate.of(2026, 11, 1)))
        assertEquals(EditPostingTimeWindow(LocalTime.of(17, 48), LocalTime.of(17, 58)),
            editPostingTimeWindow(LocalTime.of(18, 0), LocalDate.of(2026, 11, 2)))
    }

    @Test fun everyDayHasAStableDistinctRangeAroundTheBusinessTime() {
        val ranges = (1..31).map { day ->
            val date = LocalDate.of(2027, 1, day)
            editPostingTimeWindow(LocalTime.of(18, 0), date).also {
                assertEquals(it, editPostingTimeWindow(LocalTime.of(18, 0), date))
                assertEquals(10L, java.time.temporal.ChronoUnit.MINUTES.between(it.start, it.end))
                assertTrue(!it.start.isBefore(LocalTime.of(17, 40)))
                assertTrue(!it.end.isAfter(LocalTime.of(18, 20)))
            }
        }
        assertEquals(31, ranges.toSet().size)
    }

    @Test fun dailyVariationAppliesToEveryBusinessSlot() {
        listOf("Pizzaria", "Marmitaria", "Padaria", "Barbearia", "Academia", "Loja", "").forEach { business ->
            editPostingTimeCategory(business).slots.forEach { slot ->
                val first = editPostingTimeWindow(slot.time, LocalDate.of(2026, 11, 1))
                val second = editPostingTimeWindow(slot.time, LocalDate.of(2026, 11, 2))
                assertEquals(first.start.minusMinutes(7), second.start)
                assertEquals(first.end.minusMinutes(7), second.end)
            }
        }
    }

    @Test fun futureSelectionUsesTheMidpointWithoutMovingTheChosenDate() {
        val date = LocalDate.of(2026, 11, 2)
        val window = editPostingTimeWindow(LocalTime.of(18, 0), date)
        assertEquals(EditCalendarSchedule("2026-11-02", "17:53"), window.selection(date, Instant.parse("2026-11-01T23:00:00Z")))
        assertNull(window.selection(date, Instant.parse("2026-11-03T00:00:00Z")))
    }

    @Test fun aPartlyElapsedRangeSelectsTheNextWholeFutureMinute() {
        val date = LocalDate.of(2026, 11, 1)
        val window = editPostingTimeWindow(LocalTime.of(18, 0), date)
        assertEquals(EditCalendarSchedule("2026-11-01", "18:03"), window.selection(date, Instant.parse("2026-11-01T21:02:23Z")))
        assertEquals(EditCalendarSchedule("2026-11-01", "18:05"), window.selection(date, Instant.parse("2026-11-01T21:04:59Z")))
        assertNull(window.selection(date, Instant.parse("2026-11-01T21:05:00Z")))
        assertNull(window.selection(date, Instant.parse("2026-11-01T21:06:00Z")))
    }

    @Test fun aMinuteEqualToNowIsNotConsideredAFutureSelection() {
        val date = LocalDate.of(2026, 11, 1)
        val window = editPostingTimeWindow(LocalTime.of(18, 0), date)
        val now = Instant.parse("2026-11-01T21:00:00Z")
        val selected = requireNotNull(window.selection(date, now))
        assertEquals("18:01", selected.time)
        assertTrue(selected.isFuture(now))
    }

    @Test fun selectionUsesBrasiliaDayInsteadOfTheUtcDay() {
        val date = LocalDate.of(2026, 11, 1)
        val window = editPostingTimeWindow(LocalTime.of(23, 0), date)
        assertEquals(EditCalendarSchedule("2026-11-01", "23:00"), window.selection(date, Instant.parse("2026-11-02T01:01:00Z")))
    }

    @Test fun rangesAtTheDayBoundariesNeverWrapToAnotherDay() {
        (1..31).forEach { day ->
            val date = LocalDate.of(2027, 1, day)
            listOf(LocalTime.MIDNIGHT, LocalTime.of(23, 59)).forEach { base ->
                val window = editPostingTimeWindow(base, date)
                assertTrue(!window.end.isBefore(window.start))
                val selected = requireNotNull(window.selection(date, Instant.parse("2026-12-31T00:00:00Z")))
                assertEquals(date.toString(), selected.date)
                assertTrue(!LocalTime.parse(selected.time).isBefore(window.start))
                assertTrue(!LocalTime.parse(selected.time).isAfter(window.end))
            }
        }
        assertEquals(LocalTime.MIDNIGHT, editPostingTimeWindow(LocalTime.MIDNIGHT, LocalDate.of(2027, 1, 2)).start)
        assertEquals(LocalTime.of(23, 59), editPostingTimeWindow(LocalTime.of(23, 59), LocalDate.of(2027, 1, 4)).end)
    }
}
