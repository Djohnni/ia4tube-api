package br.com.ia4tube.app.feature.monthly_planning

import android.app.Application
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.DialogInterface
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TimePicker
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import br.com.ia4tube.app.ui.theme.IA4TubeTheme
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
import java.io.File
import java.time.Duration
import java.time.LocalDate
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28], qualifiers = "w320dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class CalendarRescheduleDialogTest {
    private class Host(date: LocalDate = LocalDate.now(CalendarScheduleZone), time: String = "09:00") {
        val item = MonthlyPlanningCalendarListItem(
            key = "synthetic:1", planningId = "planning", planejamentoItemId = "post",
            date = date.toString(), time = time, dateLabel = "", status = "Pronta",
            title = "Arte de teste", pedidoId = "synthetic-order", imageReady = true,
            sortKey = "", calendarRevision = 8
        )
        val saves = mutableListOf<Triple<MonthlyPlanningCalendarListItem, String, String>>()
        private val controller = Robolectric.buildActivity(ComponentActivity::class.java)
        private val decor get() = controller.get().window.decorView

        init {
            controller.get().setTheme(android.R.style.Theme_Material_NoActionBar)
            controller.setup()
            val resources = controller.get().resources
            val config = android.content.res.Configuration(resources.configuration).apply { fontScale = 1.5f }
            @Suppress("DEPRECATION")
            resources.updateConfiguration(config, resources.displayMetrics)
            controller.get().setContent {
                IA4TubeTheme {
                    MonthlyPlanningCalendarList(
                        title = "Calendário", items = listOf(item), previewToken = "", loading = false,
                        emptyText = "", onOpenOrder = {}, onRemove = {}, onShare = {},
                        onReschedule = { post, date, time -> saves.add(Triple(post, date, time)) },
                        showNextThirtyDays = true
                    )
                }
            }
            idle()
        }

        private fun roots(): List<View> = listOf(decor) + ShadowDialog.getShownDialogs()
            .filter { it.isShowing }.mapNotNull { it.window?.decorView }

        private fun views(view: View): List<View> = listOf(view) +
            if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()

        fun idle() {
            val main = shadowOf(Looper.getMainLooper())
            Snapshot.sendApplyNotifications()
            main.idle()
            roots().forEach { view ->
                val mode = if (view === decor) View.MeasureSpec.EXACTLY else View.MeasureSpec.AT_MOST
                view.measure(View.MeasureSpec.makeMeasureSpec(640, mode),
                    View.MeasureSpec.makeMeasureSpec(1782, mode))
                view.layout(0, 0, view.measuredWidth, view.measuredHeight)
            }
            main.idleFor(Duration.ofMillis(200))
            Snapshot.sendApplyNotifications()
            main.idle()
        }

        private fun descendants(node: SemanticsNode): List<SemanticsNode> =
            listOf(node) + node.children.flatMap(::descendants)

        fun nodes(): List<SemanticsNode> = roots().flatMap(::views)
            .filter { it.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView" }
            .flatMap {
                val owner = it.javaClass.getMethod("getSemanticsOwner").invoke(it) as SemanticsOwner
                descendants(owner.rootSemanticsNode)
            }

        fun text(node: SemanticsNode): String = node.config.getOrNull(SemanticsProperties.Text)
            ?.joinToString(" ") { it.text }.orEmpty()

        fun button(label: String): SemanticsNode = nodes().first {
            text(it) == label && it.config.getOrNull(SemanticsActions.OnClick) != null
        }

        fun click(label: String) {
            assertTrue(button(label).config[SemanticsActions.OnClick].action!!.invoke())
            idle()
        }

        fun openDatePicker(): DatePickerDialog {
            click(nodes().map(::text).first { it.startsWith("Data: ") })
            return ShadowDialog.getLatestDialog() as DatePickerDialog
        }

        fun selectDate(date: LocalDate) {
            val picker = openDatePicker()
            picker.updateDate(date.year, date.monthValue - 1, date.dayOfMonth)
            picker.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
            idle()
        }

        fun selectTime(hour: Int, minute: Int) {
            click(nodes().map(::text).first { it.startsWith("Horário: ") })
            val dialog = ShadowDialog.getLatestDialog() as TimePickerDialog
            val picker = views(dialog.window!!.decorView).filterIsInstance<TimePicker>().single()
            assertTrue(picker.is24HourView)
            picker.hour = hour
            picker.minute = minute
            dialog.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
            idle()
        }

        fun close() {
            ShadowDialog.getShownDialogs().filter { it.isShowing }.forEach { it.dismiss() }
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idle()
        }

        fun screenshot(filename: String) {
            val view = roots().last()
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            val output = File("build/reports/$filename")
            output.parentFile?.mkdirs()
            output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    @Test fun selectedDateAndTimeOnlyLeaveTheDialogWhenSaveIsTapped() {
        val host = Host()
        try {
            host.click("Data e horário")
            val date = LocalDate.now(CalendarScheduleZone).plusDays(2)
            host.selectDate(date)
            host.selectTime(18, 45)
            assertTrue(host.saves.isEmpty())
            assertTrue(host.nodes().any { host.text(it) == "Horário: 18:45" })
            assertTrue(host.nodes().any { host.text(it) == "Data: ${date.format(DateTimeFormatter.ofPattern("dd/MM/yyyy"))}" })
            host.screenshot("monthly-calendar-date-time-dialog.png")
            host.click("Salvar")
            assertEquals(listOf(Triple(host.item, date.toString(), "18:45")), host.saves)
            assertFalse(host.nodes().any { host.text(it) == "Alterar data e horário" })
        } finally { host.close() }
    }

    @Test fun cancelDiscardsSelectionsAndReopeningRestoresTheExistingSchedule() {
        val host = Host()
        try {
            host.click("Data e horário")
            host.selectDate(LocalDate.now(CalendarScheduleZone).plusDays(2))
            host.selectTime(18, 45)
            host.click("Cancelar")
            assertTrue(host.saves.isEmpty())
            host.click("Data e horário")
            assertTrue(host.nodes().any { host.text(it) == "Horário: 09:00" })
            val initialDate = LocalDate.parse(host.item.date).format(DateTimeFormatter.ofPattern("dd/MM/yyyy"))
            assertTrue(host.nodes().any { host.text(it) == "Data: $initialDate" })
        } finally { host.close() }
    }

    @Test fun pastScheduleCannotBeSavedAndTheDialogRemainsOpen() {
        val host = Host(time = "00:00")
        try {
            host.click("Data e horário")
            host.click("Salvar")
            assertTrue(host.saves.isEmpty())
            assertTrue(host.nodes().any { host.text(it) == "Escolha uma data e horário no futuro." })
            host.button("Cancelar")
        } finally { host.close() }
    }

    @Test fun timeCanChangeWithoutMovingTheExistingDate() {
        val host = Host(date = LocalDate.now(CalendarScheduleZone).plusDays(1))
        try {
            host.click("Data e horário")
            host.selectTime(18, 45)
            assertTrue(host.saves.isEmpty())
            host.click("Salvar")
            assertEquals(listOf(Triple(host.item, host.item.date, "18:45")), host.saves)
        } finally { host.close() }
    }

    @Test fun nativeDatePickerPreservesTheThirtyDaysDisplayedByTheCalendar() {
        val host = Host()
        try {
            host.click("Data e horário")
            val picker = host.openDatePicker().datePicker
            val first = Instant.ofEpochMilli(picker.minDate).atZone(ZoneId.systemDefault()).toLocalDate()
            val last = Instant.ofEpochMilli(picker.maxDate).atZone(ZoneId.systemDefault()).toLocalDate()
            assertEquals(LocalDate.now(CalendarScheduleZone), first)
            assertEquals(first.plusDays(29), last)
        } finally { host.close() }
    }

    @Test fun actionButtonsWrapWithoutOverlappingOnNarrowScreenWithLargeText() {
        val host = Host()
        try {
            val bounds = listOf("Compartilhar", "Data e horário", "Remover").map { host.button(it).boundsInRoot }
            bounds.forEach {
                assertTrue("Each action must fit inside the 320 dp screen", it.left >= 0 && it.right <= 640)
                assertTrue(it.width > 0 && it.height > 0)
            }
            for (i in bounds.indices) for (j in i + 1 until bounds.size) {
                assertFalse("Actions must never overlap", bounds[i].overlaps(bounds[j]))
            }
            assertTrue("Large actions must flow onto another row", bounds.map { it.top }.distinct().size > 1)
            host.screenshot("monthly-calendar-actions-large-text.png")
        } finally { host.close() }
    }
}
