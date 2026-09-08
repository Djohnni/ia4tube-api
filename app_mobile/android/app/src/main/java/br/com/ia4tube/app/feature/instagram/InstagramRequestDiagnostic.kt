package br.com.ia4tube.app.feature.instagram

enum class InstagramRequestStage {
    LOCAL_VALIDATION, REQUEST_INITIATED, HTTP_RESPONSE, INVALID_RESPONSE, TRANSPORT
}

/** Allowlisted upload evidence only. Started never means delivery or processing was confirmed. */
data class InstagramRequestDiagnostic(
    val requestStarted: Boolean,
    val responseReceived: Boolean,
    val httpStatus: Int?,
    val code: String,
    val stage: InstagramRequestStage,
    val startedAtEpochMillis: Long,
    val durationMillis: Long,
    val outcomeUnknown: Boolean
) {
    init {
        require(isAllowedCode(code) && startedAtEpochMillis >= 0 && durationMillis >= 0 &&
            (!responseReceived || requestStarted) &&
            (httpStatus == null || (responseReceived && httpStatus in 100..599)) &&
            (!outcomeUnknown || requestStarted)) { "Invalid request diagnostic" }
        require(when (stage) {
            InstagramRequestStage.LOCAL_VALIDATION -> code in localCodes && !requestStarted && !responseReceived && httpStatus == null && !outcomeUnknown
            InstagramRequestStage.REQUEST_INITIATED -> code == "request_started" && requestStarted && !responseReceived && httpStatus == null && outcomeUnknown
            InstagramRequestStage.HTTP_RESPONSE -> requestStarted && responseReceived && httpStatus != null &&
                when {
                    code == "http_success" -> httpStatus in 200..299 && !outcomeUnknown
                    code == "http_redirect_refused" -> httpStatus in 300..399 && outcomeUnknown
                    code == "session_changed" -> outcomeUnknown
                    code in serverCodes || code in setOf("http_rejected", "http_server_error") ->
                        httpStatus in 400..599 && outcomeUnknown == (httpStatus >= 500)
                    else -> false
                }
            InstagramRequestStage.INVALID_RESPONSE -> code == "response_invalid" && requestStarted && outcomeUnknown
            InstagramRequestStage.TRANSPORT -> code in setOf("transport_timeout", "transport_failure") && requestStarted && outcomeUnknown
        }) { "Invalid request diagnostic" }
    }

    companion object {
        private val localCodes = setOf("local_invalid_input", "local_unavailable", "local_session_required", "local_request_failed")
        private val fixedCodes = localCodes + setOf(
            "request_started", "http_success", "http_rejected", "http_server_error",
            "http_redirect_refused", "response_invalid", "transport_timeout", "transport_failure", "session_changed"
        )
        private val serverCodes = setOf(
            "reviewer_media_invalid", "reviewer_media_too_large", "reviewer_media_limit_reached",
            "reviewer_media_upload_in_progress", "reviewer_media_storage_unavailable",
            "connector_contract_invalid", "external_capability_disabled", "social_session_login_required",
            "social_authenticated_principal_invalid", "social_context_invalid", "social_tenant_readiness_unavailable",
            "social_rate_limited", "social_origin_forbidden", "social_request_invalid", "social_route_not_found",
            "concurrency_limit_unavailable", "rate_limit_unavailable", "permission_missing", "resource_unavailable"
        )

        fun isAllowedCode(code: String): Boolean = code in fixedCodes || code in serverCodes

        internal fun normalizedServerCode(value: Any?, status: Int): String =
            (value as? String)?.takeIf { it in serverCodes }
                ?: if (status >= 500) "http_server_error" else "http_rejected"
    }
}

/** Holds no URL, payload, header, exception, identifier, or credential. */
internal class InstagramUploadRequestTrace {
    private val startedAt = System.currentTimeMillis().coerceAtLeast(0)
    private val startedNanos = System.nanoTime()
    var requestStarted = false
        private set
    private var responseReceived = false
    private var httpStatus: Int? = null

    fun startRequest() { requestStarted = true }

    fun receiveResponse(status: Int) {
        responseReceived = true
        httpStatus = status.takeIf { it in 100..599 }
    }

    fun diagnostic(stage: InstagramRequestStage, code: String, outcomeUnknown: Boolean): InstagramRequestDiagnostic =
        InstagramRequestDiagnostic(requestStarted, responseReceived, httpStatus, code, stage,
            startedAt, ((System.nanoTime() - startedNanos) / 1_000_000L).coerceAtLeast(0), outcomeUnknown)
}
