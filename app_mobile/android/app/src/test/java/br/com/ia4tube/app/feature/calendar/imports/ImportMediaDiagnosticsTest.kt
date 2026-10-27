package br.com.ia4tube.app.feature.calendar.imports

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException

class ImportMediaDiagnosticsTest {
    @Test fun closedVocabularyFormatsOnlyEnumsAndBoundedNumbers() {
        assertEquals("iA4tubeMediaImport", ImportMediaDiagnostics.TAG)
        val lines = mutableListOf<String>()
        var now = 99L
        val diagnostics = ImportMediaDiagnostics({ lines.add(it.fixedMessage()) }, { now })
        val started = diagnostics.started()
        now = 900_000
        diagnostics.failed(ImportMediaStage.MEDIA_PUT, ImportMediaFailureReason.SOCKET_TIMEOUT, started, 503)
        now = 0
        diagnostics.failed(ImportMediaStage.UPLOAD_RESUME, ImportMediaFailureReason.RESPONSE_PARSE, started, -123)
        assertEquals(listOf("stage=MEDIA_PUT reason=SOCKET_TIMEOUT httpStatus=503 elapsedMs=300000",
            "stage=UPLOAD_RESUME reason=RESPONSE_PARSE elapsedMs=0"), lines)
        val format = Regex("stage=[A-Z_]+ reason=[A-Z_]+(?: httpStatus=[1-5][0-9]{2})? elapsedMs=[0-9]{1,6}")
        assertTrue(lines.all(format::matches))
    }

    @Test fun failingSinkAndClockNeverEscapeIntoTheTransfer() {
        val throwing = ImportMediaDiagnostics({ throw AssertionError("synthetic-secret-do-not-log") }, { 7L })
        throwing.failed(ImportMediaStage.MEDIA_PUT, ImportMediaFailureReason.NETWORK_FAILURE, 0)
        val clock = ImportMediaDiagnostics({ fail("Unusable clock must not invoke sink") }, { throw AssertionError("private-clock") })
        assertEquals(0, clock.started())
        clock.failed(ImportMediaStage.PART_AUTHORIZE, ImportMediaFailureReason.VALIDATION_FAILED, 0)
    }

    @Test fun callerCancellationDoesNotConfuseOkHttpTimeoutCancellationAndNeverReadsExceptionText() {
        val privateMessage = "https://private.invalid/id?token=synthetic-secret"
        assertEquals(ImportMediaFailureReason.CANCELLED, ImportMediaDiagnostics.networkReason(IOException(privateMessage), true))
        assertEquals(ImportMediaFailureReason.SOCKET_TIMEOUT, ImportMediaDiagnostics.networkReason(SocketTimeoutException(privateMessage), false))
        assertEquals(ImportMediaFailureReason.INTERRUPTED_IO, ImportMediaDiagnostics.networkReason(InterruptedIOException(privateMessage), false))
        assertEquals(ImportMediaFailureReason.NETWORK_FAILURE, ImportMediaDiagnostics.networkReason(IOException(privateMessage), false))
    }
}
