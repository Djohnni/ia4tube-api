package br.com.ia4tube.app.feature.monthly_planning

import br.com.ia4tube.app.data.models.UploadFile
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
}
