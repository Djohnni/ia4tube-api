package br.com.ia4tube.app.feature.edit

import org.junit.Assert.assertEquals
import org.junit.Test
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
}
