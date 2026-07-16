package br.com.ia4tube.app.feature.monthly_planning

import br.com.ia4tube.app.data.models.UploadFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
}
