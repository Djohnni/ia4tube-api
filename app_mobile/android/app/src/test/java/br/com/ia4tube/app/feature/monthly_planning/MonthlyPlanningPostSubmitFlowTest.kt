package br.com.ia4tube.app.feature.monthly_planning

import br.com.ia4tube.app.data.models.MonthlyPlanningRequestResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MonthlyPlanningPostSubmitFlowTest {
    @Test
    fun noReadyArtKeepsViewImagesDisabled() {
        val planning = planning(
            totalPosts = 2,
            posts = listOf(
                post(number = 1, ready = false),
                post(number = 2, ready = false)
            )
        )

        val status = planning.toProcessingStatus()

        assertEquals("Estamos criando suas imagens", status.title)
        assertEquals("Seu pedido foi enviado para produção.", status.message)
        assertFalse(status.canOpenResults)
        assertEquals(MonthlyPlanningResultDestination.Unavailable, planning.resultDestination())
    }

    @Test
    fun readyPlanningWithoutReadyChildImagesKeepsPolling() {
        val planning = planning(
            totalPosts = 1,
            readyPosts = 0,
            status = "Pronto",
            posts = listOf(post(number = 1, ready = false, pedidoId = "pedido-filho"))
        )

        val status = planning.toProcessingStatus()

        assertEquals("Estamos criando suas imagens", status.title)
        assertFalse(status.canOpenResults)
        assertFalse(status.fullyReady)
        assertTrue(planning.shouldContinueProcessingPolling())
        assertEquals(MonthlyPlanningResultDestination.Unavailable, planning.resultDestination())
    }

    @Test
    fun oneReadyArtFromManyEnablesButtonAndKeepsPolling() {
        val planning = planning(
            totalPosts = 3,
            readyPosts = 1,
            posts = listOf(
                post(number = 1, ready = true, pedidoId = "pedido-1"),
                post(number = 2, ready = false),
                post(number = 3, ready = false)
            )
        )

        val status = planning.toProcessingStatus()

        assertEquals("Suas imagens estão prontas", status.title)
        assertEquals("Seu pedido já possui imagens prontas para visualizar.", status.message)
        assertTrue(status.canOpenResults)
        assertFalse(status.fullyReady)
        assertTrue(planning.shouldContinueProcessingPolling())
        assertEquals(MonthlyPlanningResultDestination.PlanningResults("planning-1"), planning.resultDestination())
    }

    @Test
    fun oneTotalArtNavigatesDirectlyToOrderDetail() {
        val planning = planning(
            totalPosts = 1,
            readyPosts = 1,
            posts = listOf(post(number = 1, ready = true, pedidoId = "pedido-unico"))
        )

        assertEquals(MonthlyPlanningResultDestination.SingleOrder("pedido-unico"), planning.resultDestination())
        assertFalse(planning.shouldContinueProcessingPolling())
    }

    @Test
    fun manyTotalArtsNavigateToPlanningResultsRouteEvenWhenOnlyOneIsReady() {
        val planning = planning(
            totalPosts = 4,
            readyPosts = 1,
            posts = listOf(
                post(number = 1, ready = true, pedidoId = "pedido-1"),
                post(number = 2, ready = false),
                post(number = 3, ready = false),
                post(number = 4, ready = false)
            )
        )

        assertEquals(1, planning.readyResultPosts.size)
        assertEquals(3, planning.posts.count { !it.imageReady })
        assertEquals(MonthlyPlanningResultDestination.PlanningResults("planning-1"), planning.resultDestination())
    }

    @Test
    fun updatedPlanningStopsPollingWhenAllArtsBecomeReady() {
        val partial = planning(
            totalPosts = 2,
            readyPosts = 1,
            posts = listOf(
                post(number = 1, ready = true, pedidoId = "pedido-1"),
                post(number = 2, ready = false)
            )
        )
        val complete = planning(
            totalPosts = 2,
            readyPosts = 2,
            posts = listOf(
                post(number = 1, ready = true, pedidoId = "pedido-1"),
                post(number = 2, ready = true, pedidoId = "pedido-2")
            )
        )

        assertTrue(partial.shouldContinueProcessingPolling())
        assertFalse(partial.toProcessingStatus().fullyReady)
        assertFalse(complete.shouldContinueProcessingPolling())
        assertTrue(complete.toProcessingStatus().fullyReady)
        assertEquals("Seu pedido foi concluído.", complete.toProcessingStatus().message)
    }

    @Test
    fun firstFreeArtVideoOnlyAppearsForFreeArtFlags() {
        assertTrue(response(arteGratis = true).shouldShowFirstFreeArtVideo())
        assertTrue(response(cobrancaOrigem = "arte_gratis").shouldShowFirstFreeArtVideo())
        assertTrue(response(tipoCompra = "arte_gratis").shouldShowFirstFreeArtVideo())
        assertFalse(response().shouldShowFirstFreeArtVideo())
    }

    @Test
    fun firstFreeVideoUsesTheSameDirectResultDestination() {
        val single = planning(
            totalPosts = 1,
            readyPosts = 1,
            posts = listOf(post(number = 1, ready = true, pedidoId = "pedido-video"))
        )
        val multiple = planning(
            totalPosts = 2,
            readyPosts = 1,
            posts = listOf(
                post(number = 1, ready = true, pedidoId = "pedido-video-1"),
                post(number = 2, ready = false)
            )
        )

        assertEquals(MonthlyPlanningResultDestination.SingleOrder("pedido-video"), single.resultDestination())
        assertEquals(MonthlyPlanningResultDestination.PlanningResults("planning-1"), multiple.resultDestination())
    }

    private fun planning(
        totalPosts: Int,
        readyPosts: Int = 0,
        status: String = "Em produção",
        posts: List<MonthlyPlanningPost>
    ): MonthlyPlanningSummary {
        return MonthlyPlanningSummary(
            id = "planning-1",
            title = "Planejamento Teste",
            status = status,
            totalPosts = totalPosts,
            readyPosts = readyPosts,
            productionPosts = (totalPosts - readyPosts).coerceAtLeast(0),
            plannedPosts = 0,
            posts = posts
        )
    }

    private fun post(
        number: Int,
        ready: Boolean,
        pedidoId: String = if (ready) "pedido-$number" else ""
    ): MonthlyPlanningPost {
        return MonthlyPlanningPost(
            number = number,
            itemId = "item-$number",
            planningId = "planning-1",
            dateLabel = "01/01 às 09:00",
            objective = "Objetivo $number",
            status = if (ready) "Pronta" else "Em produção",
            caption = "",
            pedidoId = pedidoId,
            imageReady = ready
        )
    }

    private fun response(
        arteGratis: Boolean = false,
        cobrancaOrigem: String = "",
        tipoCompra: String = ""
    ): MonthlyPlanningRequestResponse {
        return MonthlyPlanningRequestResponse(
            planningId = "planning-1",
            ciclo = "2099-01",
            status = "em_producao",
            statusLabel = "Em produção",
            quantidadeReservada = 1,
            artesDesteCiclo = 1,
            reservadasNoPlanejamento = 1,
            livresParaCriarArte = 0,
            cobrancaOrigem = cobrancaOrigem,
            tipoCompra = tipoCompra,
            arteGratis = arteGratis
        )
    }
}
