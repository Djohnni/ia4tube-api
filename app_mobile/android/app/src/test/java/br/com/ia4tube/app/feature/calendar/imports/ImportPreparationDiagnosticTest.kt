package br.com.ia4tube.app.feature.calendar.imports

import org.junit.Assert.*
import org.junit.Test

class ImportPreparationDiagnosticTest {
    @Test fun `only confirmed schedule refusal diagnostics invite correction of the same file`() {
        val occupied = importPreparationDiagnostic(null, "import_calendar_schedule_rejected_occupied")
        assertTrue(occupied.contains("Escolha outro horário")); assertTrue(occupied.contains("arquivo foi preservado"))
        assertTrue(importPreparationDiagnostic(null, "import_calendar_schedule_rejected_outside_window").contains("futuros, dentro de 180 dias"))
        assertTrue(importPreparationDiagnostic(null, "import_calendar_schedule_rejected_invalid").contains("horário de Brasília"))
        val unresolved = importPreparationDiagnostic(null, "calendar_import_submission_time_occupied", 409)
        assertFalse(unresolved.contains("Escolha outro horário")); assertTrue(unresolved.contains("P00"))
    }
    @Test fun `http failures have a distinct bounded numeric reference without response content`() {
        val statuses = listOf(401, 403, 404, 503)
        val messages = statuses.map { importPreparationDiagnostic(ImportPreparationDiagnosticStage.PREVIEW, "import_request_rejected", it) }
        assertEquals(statuses.size, messages.toSet().size)
        messages.zip(statuses).forEach { (message, status) ->
            assertTrue(message.contains("P14")); assertTrue(message.contains("HTTP $status."))
            assertTrue(message.contains("consulta da prévia")); assertTrue(message.contains("rascunho foi mantido"))
        }
        for (status in listOf(null, -1, 200, 399, 600, Int.MAX_VALUE)) {
            val message = importPreparationDiagnostic(ImportPreparationDiagnosticStage.STATUS, "import_request_rejected", status)
            assertTrue(message.contains("P14")); assertFalse(message.contains("HTTP"))
        }
        val untrusted = importPreparationDiagnostic(null, "https://private.invalid/?token=DO_NOT_DISPLAY", 503)
        assertFalse(untrusted.contains("HTTP")); assertFalse(untrusted.contains("DO_NOT_DISPLAY")); assertTrue(untrusted.contains("P00"))
    }
    @Test fun `each restore step is distinguishable without exposing input`() {
        val messages = ImportPreparationDiagnosticStage.entries.map { importPreparationDiagnostic(it, "import_response_invalid") }
        assertEquals(ImportPreparationDiagnosticStage.entries.size, messages.toSet().size)
        assertTrue(messages.all { it.contains("P01") })
    }
    @Test fun `unknown server content never appears in the diagnostic`() {
        val message = importPreparationDiagnostic(null, "https://private.invalid/?token=DO_NOT_DISPLAY")
        assertTrue(message.contains("P00"))
        assertFalse(message.contains("private.invalid"))
        assertFalse(message.contains("DO_NOT_DISPLAY"))
    }
    @Test fun `known mismatches have different references and preserve the draft`() {
        val source = importPreparationDiagnostic(ImportPreparationDiagnosticStage.METADATA, "import_preparation_source_changed")
        val preview = importPreparationDiagnostic(ImportPreparationDiagnosticStage.PREVIEW, "import_preparation_preview_invalid")
        assertTrue(source.contains("P06"))
        assertTrue(preview.contains("P08"))
        assertTrue(preview.contains("rascunho foi mantido"))
    }
}
