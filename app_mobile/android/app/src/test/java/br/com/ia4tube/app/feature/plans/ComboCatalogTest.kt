package br.com.ia4tube.app.feature.plans
import org.junit.Assert.*
import org.junit.Test
class ComboCatalogTest {
    @Test fun approvedOffersHaveExactIndependentQuantitiesAndPrices() {
        assertEquals(listOf(69,99,139,199,259), mediaCombos.map { it.priceReais })
        assertEquals(listOf(10,10,15,20,20), mediaCombos.map { it.images })
        assertEquals(listOf(0,4,6,10,15), mediaCombos.map { it.videos })
        assertEquals(5, mediaCombos.map { it.id }.toSet().size)
        assertTrue(mediaCombos.all { it.id.endsWith("_v1") })
        assertTrue(mediaCombos.none { it.id in setOf("i4_essencial","i4_profissional","i4_empresarial") })
    }
    @Test fun labelsDescribeDeliveredMediaRatherThanAnAggregateSharedBalance() {
        assertEquals("10 imagens",mediaCombos.first().allowance)
        assertEquals("10 imagens · 4 vídeos",mediaCombos[1].allowance)
        assertEquals("20 imagens · 15 vídeos",mediaCombos.last().allowance)
    }
}
