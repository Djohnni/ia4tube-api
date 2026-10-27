package br.com.ia4tube.app.feature.calendar.imports

import android.util.Log
import java.io.InterruptedIOException
import java.net.SocketTimeoutException

/** Closed vocabulary only. No route, identifier, content, credential or Throwable reaches the sink. */
internal enum class ImportMediaStage {
    CAPABILITIES, UPLOAD_START, UPLOAD_STATUS, UPLOAD_RESUME, UPLOAD_COMPLETE, UPLOAD_CANCEL,
    PART_AUTHORIZE, PART_RESOLVE, MEDIA_PUT, PREPARATION, PREPARATION_STATUS, PREVIEW_METADATA,
    CALENDAR_SUBMISSION, CALENDAR_SUBMISSION_STATUS, SCHEDULE_AVAILABILITY, SCHEDULE, SCHEDULE_STATUS,
    GENERATED_SOURCE, CHECKPOINT, TRANSFER_VALIDATION, UPLOAD_RESPONSE_VALIDATION, RECEIPT_VALIDATION,
    SOURCE_INSPECTION, SOURCE_PART_READ, PART_CHECKSUM
}

internal enum class ImportMediaFailureReason {
    CANCELLED, SOCKET_TIMEOUT, INTERRUPTED_IO, NETWORK_FAILURE, HTTP_REJECTED, RESPONSE_PARSE,
    VALIDATION_FAILED, SESSION_CHANGED, OWNER_UNAVAILABLE, SOURCE_UNAVAILABLE, SOURCE_CHANGED,
    CHECKPOINT_FAILURE, UPLOAD_BINDING_INVALID, RECEIPTS_CHANGED, RECEIPT_INVALID, RECEIPT_CONFLICT,
    PART_NOT_OBSERVED, UPLOAD_STATE_INVALID, STATE_TRANSITION_REJECTED
}

internal data class ImportMediaDiagnosticEvent(
    val stage: ImportMediaStage,
    val reason: ImportMediaFailureReason,
    val httpStatus: Int?,
    val elapsedMs: Long
) {
    init { require(httpStatus == null || httpStatus in 100..599); require(elapsedMs in 0..300_000) }
    fun fixedMessage(): String = "stage=${stage.name} reason=${reason.name}" +
        (httpStatus?.let { " httpStatus=$it" } ?: "") + " elapsedMs=$elapsedMs"
}

internal class ImportMediaDiagnostics(
    private val sink: (ImportMediaDiagnosticEvent) -> Unit = { Log.w(TAG, it.fixedMessage()); Unit },
    private val monotonicMs: () -> Long = { System.nanoTime() / 1_000_000 }
) {
    fun started(): Long = try { monotonicMs() } catch (_: Throwable) { 0L }

    /** Diagnostics can never change an upload result, including a failing Android log implementation. */
    fun failed(stage: ImportMediaStage, reason: ImportMediaFailureReason, startedMs: Long, httpStatus: Int? = null) {
        try {
            val elapsed = (monotonicMs() - startedMs).coerceIn(0, 300_000)
            sink(ImportMediaDiagnosticEvent(stage, reason, httpStatus?.takeIf { it in 100..599 }, elapsed))
        } catch (_: Throwable) { /* Error reporting must never interrupt a callback or transfer. */ }
    }

    companion object {
        const val TAG = "iA4tubeMediaImport"
        fun networkReason(error: java.io.IOException, cancelledByCaller: Boolean): ImportMediaFailureReason = when {
            cancelledByCaller -> ImportMediaFailureReason.CANCELLED
            error is SocketTimeoutException -> ImportMediaFailureReason.SOCKET_TIMEOUT
            error is InterruptedIOException -> ImportMediaFailureReason.INTERRUPTED_IO
            else -> ImportMediaFailureReason.NETWORK_FAILURE
        }
    }
}
