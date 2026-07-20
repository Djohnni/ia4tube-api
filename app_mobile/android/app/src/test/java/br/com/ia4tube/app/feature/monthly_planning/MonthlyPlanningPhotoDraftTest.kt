package br.com.ia4tube.app.feature.monthly_planning

import br.com.ia4tube.app.data.models.UploadFile
import br.com.ia4tube.app.data.models.MonthlyPlanningDiscoveredProduct
import br.com.ia4tube.app.data.models.MonthlyPlanningProductCrop
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MonthlyPlanningPhotoDraftTest {
    private fun upload(name: String = "foto.jpg") = UploadFile(
        fileName = name,
        contentType = "image/jpeg",
        bytes = byteArrayOf(1, 2, 3)
    )

    @Test
    fun initialStateShowsFoto1ExpandedAndFotos2To4Collapsed() {
        val state = MonthlyPlanningUiState()

        assertEquals(4, state.photos.size)
        assertEquals(listOf(1, 2, 3, 4), state.photos.map { it.number })
        assertEquals(listOf("fixed-photo-1", "fixed-photo-2", "fixed-photo-3", "fixed-photo-4"), state.photos.map { it.id })
        assertTrue(state.photos[0].expanded)
        assertTrue(state.photos.drop(1).all { !it.expanded })
        assertTrue(state.photos.all { it.fixedSlot })
    }

    @Test
    fun emptyFixedSlotsAreVisibleButInactive() {
        val state = MonthlyPlanningUiState()

        assertEquals(emptyList<MonthlyPlanningPhotoDraft>(), state.activePhotos)
        assertEquals(0, state.activePhotoCount)
        assertEquals(0, state.countedPhotoSlots)
        assertTrue(state.canAddMorePhotos)
    }

    @Test
    fun objectiveTextOrImageActivateASlotWithoutRequiringImage() {
        val objectiveOnly = MonthlyPlanningPhotoDraft(id = "a", number = 1, objetivo = "Divulgar servico")
        val textOnly = MonthlyPlanningPhotoDraft(id = "b", number = 2, escritaImagem = "Peca hoje")
        val imageOnly = MonthlyPlanningPhotoDraft(id = "c", number = 3, file = upload())

        assertTrue(objectiveOnly.isActive)
        assertTrue(textOnly.isActive)
        assertTrue(imageOnly.isActive)
    }

    @Test
    fun withoutPhotoChoiceAloneDoesNotActivateASlot() {
        val withoutPhotoOnly = MonthlyPlanningPhotoDraft(
            id = "sem-foto",
            number = 1,
            withoutPhotoSelected = true
        )

        assertTrue(withoutPhotoOnly.hasUserData)
        assertFalse(withoutPhotoOnly.isActive)

        val state = MonthlyPlanningUiState(
            photos = listOf(withoutPhotoOnly.copy(fixedSlot = true))
        )

        assertEquals(emptyList<MonthlyPlanningPhotoDraft>(), state.activePhotos)
        assertEquals(0, state.activePhotoCount)
    }

    @Test
    fun withoutPhotoChoiceWithObjectiveOrWritingActivatesSlot() {
        val withObjective = MonthlyPlanningPhotoDraft(
            id = "objetivo",
            number = 1,
            withoutPhotoSelected = true,
            objetivo = "Divulgar agenda"
        )
        val withWriting = MonthlyPlanningPhotoDraft(
            id = "escrita",
            number = 2,
            withoutPhotoSelected = true,
            escritaImagem = "Agende hoje"
        )

        assertTrue(withObjective.isActive)
        assertTrue(withWriting.isActive)
    }

    @Test
    fun togglingWithoutPhotoChoiceCanBeUndone() {
        val empty = MonthlyPlanningPhotoDraft(id = "photo-1", number = 1)
        val selected = empty.toggleWithoutPhotoChoice()
        val unselected = selected.toggleWithoutPhotoChoice()

        assertTrue(selected.withoutPhotoSelected)
        assertFalse(selected.isActive)
        assertFalse(unselected.withoutPhotoSelected)
        assertFalse(unselected.isActive)
    }

    @Test
    fun addingPhotoAfterWithoutPhotoChoiceClearsTheChoice() {
        val selectedWithoutPhoto = MonthlyPlanningPhotoDraft(
            id = "photo-1",
            number = 1,
            withoutPhotoSelected = true,
            objetivo = "Mostrar produto"
        )
        val withPhoto = selectedWithoutPhoto.withPhotoFile(upload("produto.jpg"))

        assertFalse(withPhoto.withoutPhotoSelected)
        assertEquals("Mostrar produto", withPhoto.objetivo)
        assertEquals("produto.jpg", withPhoto.file?.fileName)
        assertTrue(withPhoto.isActive)
    }

    @Test
    fun removingPhotoReturnsToWithoutPhotoChoiceAndPreservesText() {
        val withPhoto = MonthlyPlanningPhotoDraft(
            id = "photo-1",
            number = 1,
            file = upload(),
            objetivo = "Anunciar agenda",
            escritaImagem = "Vagas abertas",
            nivelEdicao = 3
        )
        val withoutPhoto = withPhoto.withRemovedPhotoFile()

        assertNull(withoutPhoto.file)
        assertTrue(withoutPhoto.withoutPhotoSelected)
        assertEquals("Anunciar agenda", withoutPhoto.objetivo)
        assertEquals("Vagas abertas", withoutPhoto.escritaImagem)
        assertEquals(3, withoutPhoto.nivelEdicao)
        assertTrue(withoutPhoto.isActive)
    }

    @Test
    fun editLevelAloneDoesNotActivateAnEmptySlot() {
        val levelOnly = MonthlyPlanningPhotoDraft(
            id = "empty-level",
            number = 1,
            nivelEdicao = DEFAULT_MONTHLY_PLANNING_PHOTO_EDIT_LEVEL + 1
        )

        assertFalse(levelOnly.isActive)
    }

    @Test
    fun manualSlotsStartWithoutDiscoveryMetadataOrPrice() {
        val state = MonthlyPlanningUiState()

        assertTrue(state.photos.all { it.produtoIdentificado.isEmpty() })
        assertTrue(state.photos.all { it.preco.isEmpty() })
    }

    @Test
    fun optionalPriceAloneDoesNotActivateAnEmptyManualSlot() {
        val priceOnly = MonthlyPlanningPhotoDraft(
            id = "price-only",
            number = 1,
            preco = "R$ 19,90"
        )

        assertTrue(priceOnly.hasUserData)
        assertFalse(priceOnly.isActive)
    }

    @Test
    fun identifiedProductActivatesBlockEvenWithoutPhotoOrFormFields() {
        val discovered = MonthlyPlanningPhotoDraft(
            id = "discovered-1",
            number = 1,
            produtoIdentificado = "Frango assado"
        )

        assertTrue(discovered.isActive)
        assertNull(discovered.file)
    }

    @Test
    fun imageRemovalPreservesTextsAndLevel() {
        val filled = MonthlyPlanningPhotoDraft(
            id = "photo-1",
            number = 1,
            file = upload(),
            objetivo = "Anunciar agenda",
            escritaImagem = "Vagas abertas",
            nivelEdicao = 3
        )
        val withoutImage = filled.copy(file = null)

        assertEquals("Anunciar agenda", withoutImage.objetivo)
        assertEquals("Vagas abertas", withoutImage.escritaImagem)
        assertEquals(3, withoutImage.nivelEdicao)
        assertTrue(withoutImage.isActive)
    }

    @Test
    fun collapsingAndExpandingDoesNotEraseSlotData() {
        val expanded = MonthlyPlanningPhotoDraft(
            id = "photo-2",
            number = 2,
            objetivo = "Mostrar bastidores",
            escritaImagem = "Conheca nossa rotina",
            expanded = true
        )
        val collapsed = expanded.copy(expanded = false)

        assertFalse(collapsed.expanded)
        assertEquals(expanded.objetivo, collapsed.objetivo)
        assertEquals(expanded.escritaImagem, collapsed.escritaImagem)
        assertEquals(expanded.id, collapsed.id)
    }

    @Test
    fun addedSlotsHaveStableIdsSeparateFromDisplayedNumber() {
        val foto5 = MonthlyPlanningPhotoDraft(id = "extra-photo-stable-5", number = 5, fixedSlot = false)
        val renumbered = foto5.copy(number = 4)

        assertEquals("extra-photo-stable-5", renumbered.id)
        assertNotEquals(foto5.number, renumbered.number)
    }

    @Test
    fun activeAndAddedSlotsRespectTheTwentyArtLimit() {
        val activeFixed = createInitialMonthlyPlanningPhotoDrafts()
            .mapIndexed { index, photo ->
                if (index == 0) photo.copy(objetivo = "Objetivo") else photo
            }
        val withFoto5 = activeFixed + MonthlyPlanningPhotoDraft(id = "extra-5", number = 5, fixedSlot = false)
        val state = MonthlyPlanningUiState(photos = withFoto5)

        assertEquals(1, state.activePhotoCount)
        assertEquals(2, state.countedPhotoSlots)
        assertTrue(state.canAddMorePhotos)

        val atLimit = (1..MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST).map { index ->
            MonthlyPlanningPhotoDraft(id = "extra-$index", number = index, fixedSlot = false)
        }
        val limitState = MonthlyPlanningUiState(photos = atLimit)

        assertEquals(MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST, limitState.countedPhotoSlots)
        assertFalse(limitState.canAddMorePhotos)
    }

    @Test
    fun mixedOrderOnlySendsActiveSlotsAndPreservesNoPhotoPayload() {
        val withPhoto = MonthlyPlanningPhotoDraft(
            id = "photo-1",
            number = 1,
            file = upload("foto-1.jpg"),
            objetivo = "Promover servico"
        )
        val withoutPhotoAndObjective = MonthlyPlanningPhotoDraft(
            id = "photo-2",
            number = 2,
            withoutPhotoSelected = true,
            objetivo = "Avisar horario",
            objetivoId = "horario_atendimento",
            escritaImagem = "Atendimento ate as 18h",
            nivelEdicao = 3
        )
        val emptyWithoutPhoto = MonthlyPlanningPhotoDraft(
            id = "photo-3",
            number = 3,
            withoutPhotoSelected = true
        )
        val state = MonthlyPlanningUiState(
            photos = listOf(withPhoto, withoutPhotoAndObjective, emptyWithoutPhoto)
        )

        val requestPhotos = state.activePhotos.map { it.toRequestInput() }

        assertEquals(2, requestPhotos.size)
        assertEquals("foto-1.jpg", requestPhotos[0].file?.fileName)
        assertFalse(requestPhotos[0].withoutPhotoSelected)
        assertEquals("photo-2", requestPhotos[1].slotId)
        assertEquals(2, requestPhotos[1].order)
        assertNull(requestPhotos[1].file)
        assertTrue(requestPhotos[1].withoutPhotoSelected)
        assertEquals("Avisar horario", requestPhotos[1].objetivo)
        assertEquals("horario_atendimento", requestPhotos[1].objetivoId)
        assertEquals("Atendimento ate as 18h", requestPhotos[1].escritaImagem)
        assertEquals(3, requestPhotos[1].nivelEdicao)
        assertTrue(requestPhotos[1].orientacao.contains("sem foto"))
    }

    @Test
    fun manualSlotRequestKeepsObjectiveWritingLevelAndPhotoUnchanged() {
        val manual = MonthlyPlanningPhotoDraft(
            id = "manual-photo-1",
            number = 1,
            file = upload("manual.jpg"),
            objetivo = "Divulgar o atendimento",
            objetivoId = "atrair-clientes",
            escritaImagem = "Agende hoje",
            nivelEdicao = 3
        )

        val request = manual.toRequestInput()

        assertEquals("manual-photo-1", request.slotId)
        assertEquals("manual.jpg", request.file?.fileName)
        assertEquals("Divulgar o atendimento", request.objetivo)
        assertEquals("atrair-clientes", request.objetivoId)
        assertEquals("Agende hoje", request.escritaImagem)
        assertEquals(3, request.nivelEdicao)
        assertFalse(request.withoutPhotoSelected)
        assertEquals("", request.preco)
        assertEquals("", request.produtoIdentificado)
    }

    @Test
    fun discoveryMetadataAndOptionalPriceArePreservedInRequestWithoutChangingObjectiveOrWriting() {
        val discovered = MonthlyPlanningPhotoDraft(
            id = "discovered-1",
            number = 5,
            produtoIdentificado = "Frango assado",
            preco = "R$ 29,90"
        )

        val request = discovered.toRequestInput()

        assertEquals("Frango assado", request.produtoIdentificado)
        assertEquals("R$ 29,90", request.preco)
        assertEquals("", request.objetivo)
        assertEquals("", request.escritaImagem)
        assertNull(request.file)
        assertTrue(request.orientacao.contains("Produto identificado: Frango assado"))
        assertTrue(request.orientacao.contains("Preco informado: R$ 29,90"))
    }

    @Test
    fun discoveryFillsOnlyEmptyBlocksAndPreservesManualContent() {
        val manual = MonthlyPlanningPhotoDraft(
            id = "fixed-photo-1",
            number = 1,
            objetivo = "Objetivo manual",
            escritaImagem = "Texto manual",
            expanded = true,
            fixedSlot = true
        )
        val empty = MonthlyPlanningPhotoDraft(
            id = "fixed-photo-2",
            number = 2,
            fixedSlot = true
        )

        val result = appendDiscoveredProductsToPlanning(
            currentPhotos = listOf(manual, empty),
            products = listOf(MonthlyPlanningDiscoveredProduct(name = "Frango assado", price = "R$ 29,90")),
            technicalLimit = 36,
            cropFactory = { null }
        )

        assertEquals("Objetivo manual", result.photos[0].objetivo)
        assertEquals("Texto manual", result.photos[0].escritaImagem)
        assertEquals("", result.photos[0].produtoIdentificado)
        assertEquals("Frango assado", result.photos[1].produtoIdentificado)
        assertEquals("R$ 29,90", result.photos[1].preco)
        assertEquals("", result.photos[1].objetivo)
        assertEquals("", result.photos[1].escritaImagem)
        assertEquals(1, result.added)
    }

    @Test
    fun discoveryDeduplicatesEquivalentNamesButKeepsProductVariants() {
        val result = appendDiscoveredProductsToPlanning(
            currentPhotos = createInitialMonthlyPlanningPhotoDrafts(),
            products = listOf(
                MonthlyPlanningDiscoveredProduct(name = "Coca-Cola"),
                MonthlyPlanningDiscoveredProduct(name = "coca cola"),
                MonthlyPlanningDiscoveredProduct(name = "Coca-Cola Zero")
            ),
            technicalLimit = 36,
            cropFactory = { null }
        )

        assertEquals(2, result.added)
        assertEquals(
            listOf("Coca-Cola", "Coca-Cola Zero"),
            result.photos.map { it.produtoIdentificado }.filter { it.isNotBlank() }
        )
    }

    @Test
    fun discoveryUsesCropOnlyWhenBackendMarkedItUsable() {
        val crop = MonthlyPlanningProductCrop(0.1, 0.1, 0.5, 0.5)
        var cropCalls = 0
        val result = appendDiscoveredProductsToPlanning(
            currentPhotos = createInitialMonthlyPlanningPhotoDrafts(),
            products = listOf(
                MonthlyPlanningDiscoveredProduct(name = "Com recorte", useCrop = true, crop = crop),
                MonthlyPlanningDiscoveredProduct(name = "Sem recorte", useCrop = false, crop = crop)
            ),
            technicalLimit = 36,
            cropFactory = {
                cropCalls += 1
                upload("crop.jpg")
            }
        )

        assertEquals(1, cropCalls)
        assertEquals("crop.jpg", result.photos[0].file?.fileName)
        assertNull(result.photos[1].file)
    }

    @Test
    fun discoveryCanExceedManualTwentyOnlyUpToBackendTechnicalLimit() {
        val manualTwenty = (1..MONTHLY_PLANNING_MAX_ARTS_PER_REQUEST).map { index ->
            MonthlyPlanningPhotoDraft(
                id = "manual-$index",
                number = index,
                objetivo = "Objetivo $index",
                fixedSlot = false
            )
        }
        val result = appendDiscoveredProductsToPlanning(
            currentPhotos = manualTwenty,
            products = (1..20).map { MonthlyPlanningDiscoveredProduct(name = "Produto $it") },
            technicalLimit = 24,
            cropFactory = { null }
        )

        assertEquals(4, result.added)
        assertTrue(result.limitReached)
        assertEquals(24, result.photos.count { it.isActive })
        val state = MonthlyPlanningUiState(
            photos = result.photos,
            technicalPlanningLimit = 24
        )
        assertEquals(24, state.requestMaxArts)
        assertFalse(state.canAddMorePhotos)
    }
}
