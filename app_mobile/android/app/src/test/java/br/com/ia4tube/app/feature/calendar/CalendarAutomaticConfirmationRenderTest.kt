package br.com.ia4tube.app.feature.calendar

import android.app.Application
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import br.com.ia4tube.app.feature.calendar.imports.ImportOwner
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowDialog
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class CalendarAutomaticConfirmationRenderTest {
    private data class PreferenceWrite(val enabled: Boolean, val revision: Long)

    private class Fake : CalendarGateway {
        private val previousBinding = CalendarBinding("11111111-1111-4111-8111-111111111111", "123456789", 64)
        var snapshot = CalendarSnapshot(
            enabled = true, automatic = true, connected = true, preferenceRevision = 2,
            username = "conta_sintetica", operationsAllowed = true,
            identity = ImportOwner("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"),
            preferenceBinding = previousBinding,
            connectionBinding = previousBinding.copy(connectionRevision = 72)
        )
        var reads = 0
        val writes = mutableListOf<PreferenceWrite>()
        var acknowledgement: CompletableDeferred<Unit>? = null

        override suspend fun list(): CalendarSnapshot { reads++; return snapshot }

        override suspend fun preferences(enabled: Boolean, revision: Long): CalendarSnapshot {
            writes += PreferenceWrite(enabled, revision)
            check(enabled) { "These confirmation tests must not pause automatic programming" }
            check(revision == snapshot.preferenceRevision)
            snapshot = snapshot.copy(automatic = true, preferenceRevision = revision + 1,
                preferenceBinding = snapshot.connectionBinding)
            acknowledgement?.await()
            return snapshot
        }

        override suspend fun edit(item: ScheduledArt, action: String, caption: String, date: String, time: String): CalendarSnapshot =
            error("Consent confirmation must not edit or send an item")
    }

    private class Host(val fake: Fake = Fake()) {
        val model = CalendarViewModel({ "synthetic-only" }, "synthetic-only", fake)
        private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        private val activity = controller.get()

        init {
            activity.setTheme(android.R.style.Theme_Material_NoActionBar)
            controller.setup()
            activity.setContent { IA4TubeTheme { Column { CalendarAutomationSettings(model) } } }
            model.refresh()
            idle()
        }

        private fun roots(): List<View> = listOf(activity.window.decorView) + ShadowDialog.getShownDialogs()
            .filter { it.isShowing }.mapNotNull { it.window?.decorView }

        private fun layout(view: View) {
            view.requestLayout()
            view.measure(View.MeasureSpec.makeMeasureSpec(822, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(1782, View.MeasureSpec.EXACTLY))
            view.layout(0, 0, 822, 1782)
        }

        fun idle() {
            val main = shadowOf(Looper.getMainLooper())
            repeat(3) {
                Snapshot.sendApplyNotifications()
                main.idle()
                roots().forEach(::layout)
                main.idleFor(Duration.ofMillis(100))
            }
            Snapshot.sendApplyNotifications()
            main.idle()
        }

        private fun owners(view: View): List<SemanticsOwner> {
            val own = if (view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView")
                listOf(view.javaClass.getMethod("getSemanticsOwner").invoke(view) as SemanticsOwner) else emptyList()
            return own + if (view is ViewGroup) (0 until view.childCount).flatMap { owners(view.getChildAt(it)) } else emptyList()
        }

        private fun descendants(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descendants)
        fun nodes(): List<SemanticsNode> = roots().flatMap(::owners).flatMap { descendants(it.rootSemanticsNode) }
        fun dialogNodes(): List<SemanticsNode> = ShadowDialog.getShownDialogs().filter { it.isShowing }
            .mapNotNull { it.window?.decorView }.flatMap(::owners).flatMap { descendants(it.rootSemanticsNode) }
        fun text(node: SemanticsNode): String = node.config.getOrNull(SemanticsProperties.Text)
            ?.joinToString(" ") { it.text }.orEmpty()
        fun hasText(value: String): Boolean = nodes().any { text(it).contains(value) }

        fun action(label: String): () -> Boolean {
            val node = nodes().first { text(it) == label && it.config.getOrNull(SemanticsActions.OnClick) != null }
            assertFalse("'$label' must be enabled before capturing a user click", node.config.contains(SemanticsProperties.Disabled))
            return requireNotNull(node.config[SemanticsActions.OnClick].action)
        }

        fun click(label: String) { assertTrue(action(label).invoke()); idle() }

        fun close() {
            ShadowDialog.getShownDialogs().filter { it.isShowing }.forEach { it.dismiss() }
            model.dispose()
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun reconnectedRevisionNeedsRenewalAndOpeningOrCancellingDoesNotWrite() {
        val host = Host()
        try {
            assertTrue(host.model.uiState.value.data.requiresConsentRenewal)
            assertFalse(host.model.uiState.value.data.automaticAuthorized)
            assertTrue(host.hasText("Confirmar novamente"))
            assertFalse(host.hasText("A programação está ativada"))
            assertFalse(host.hasText("Pausar programação automática"))
            assertTrue(host.fake.writes.isEmpty())

            host.click("Confirmar novamente")
            assertTrue(host.dialogNodes().any { host.text(it) == "Confirmar novamente a programação?" })
            assertTrue(host.dialogNodes().any { host.text(it).contains("@conta_sintetica") })
            assertTrue(host.dialogNodes().any { host.text(it).contains("Esta confirmação não envia seu pedido") })
            assertTrue(host.fake.writes.isEmpty())
            assertEquals(1, host.fake.reads)

            host.click("Voltar")
            assertTrue(host.dialogNodes().isEmpty())
            assertTrue(host.fake.writes.isEmpty())
            assertTrue(host.model.uiState.value.data.requiresConsentRenewal)
        } finally { host.close() }
    }

    @Test fun explicitConfirmationWritesOnceAndWaitsForAcknowledgedBinding() {
        val fake = Fake().apply { acknowledgement = CompletableDeferred() }
        val host = Host(fake)
        try {
            host.click("Confirmar novamente")
            val confirm = host.action("Confirmar")
            assertTrue(confirm.invoke())
            assertTrue(confirm.invoke())
            host.idle()
            assertEquals(listOf(PreferenceWrite(true, 2)), fake.writes)
            assertTrue(host.model.uiState.value.busy)
            assertFalse(host.model.uiState.value.data.automaticAuthorized)

            fake.acknowledgement!!.complete(Unit)
            host.idle()
            assertFalse(host.model.uiState.value.busy)
            assertTrue(host.model.uiState.value.data.automaticAuthorized)
            assertFalse(host.model.uiState.value.data.requiresConsentRenewal)
            assertEquals(72L, host.model.uiState.value.data.preferenceBinding!!.connectionRevision)
            assertEquals(3L, host.model.uiState.value.data.preferenceRevision)
            assertTrue(host.hasText("Pausar programação automática"))
            assertTrue(host.dialogNodes().isEmpty())
            assertEquals(listOf(PreferenceWrite(true, 2)), fake.writes)
            assertEquals(1, fake.reads)
        } finally { host.close() }
    }

    @Test fun changedConnectionRevisionInvalidatesTheOpenConfirmationAndItsOldClick() =
        assertChangedTargetRejectsOldClick { snapshot ->
            snapshot.copy(connectionBinding = snapshot.connectionBinding!!.copy(connectionRevision = 73))
        }

    @Test fun changedAccountInvalidatesTheOpenConfirmationAndItsOldClick() =
        assertChangedTargetRejectsOldClick { snapshot ->
            snapshot.copy(username = "outra_conta_sintetica", connectionBinding = CalendarBinding(
                "44444444-4444-4444-8444-444444444444", "987654321", 1))
        }

    @Test fun pauseInvalidatesTheOpenConfirmationWithoutWriting() {
        val host = Host()
        try {
            host.click("Confirmar novamente")
            val oldConfirm = host.action("Confirmar")
            host.model.onPause()
            host.idle()
            assertTrue(host.dialogNodes().isEmpty())
            assertFalse(host.model.uiState.value.fresh)
            assertTrue(oldConfirm.invoke())
            host.idle()
            assertTrue(host.fake.writes.isEmpty())
        } finally { host.close() }
    }

    private fun assertChangedTargetRejectsOldClick(change: (CalendarSnapshot) -> CalendarSnapshot) {
        val host = Host()
        try {
            host.click("Confirmar novamente")
            val oldConfirm = host.action("Confirmar")
            host.fake.snapshot = change(host.fake.snapshot)
            host.model.refresh()
            host.idle()
            assertTrue("A changed target must dismiss the previous consent", host.dialogNodes().isEmpty())
            assertTrue(host.fake.writes.isEmpty())
            assertTrue(host.model.uiState.value.fresh)

            // Even a queued click from the removed dialog cannot approve the replacement target.
            assertTrue(oldConfirm.invoke())
            host.idle()
            assertTrue(host.fake.writes.isEmpty())
            assertFalse(host.model.uiState.value.data.automaticAuthorized)
            assertEquals(64L, host.model.uiState.value.data.preferenceBinding!!.connectionRevision)
            assertEquals(2, host.fake.reads)
        } finally { host.close() }
    }
}
