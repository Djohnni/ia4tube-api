package br.com.ia4tube.app.feature.calendar.imports

import org.junit.Assert.*
import org.junit.Test

class ImportPreparationDiagnosticTest {
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
