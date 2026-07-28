package br.com.ia4tube.app.core.notifications

import br.com.ia4tube.app.data.models.ApiResult
import kotlinx.coroutines.delay

internal class FcmRetryPolicy(
    private val maxAttempts: Int = 3,
    private val delaysMs: List<Long> = listOf(250L, 1_000L),
    private val sleeper: suspend (Long) -> Unit = { delay(it) }
) {
    init {
        require(maxAttempts in 1..3)
    }

    suspend fun <T> execute(operation: suspend () -> ApiResult<T>): ApiResult<T> {
        var last: ApiResult<T>? = null

        repeat(maxAttempts) { index ->
            val result = operation()
            last = result
            if (result is ApiResult.Success || !isTransient(result)) {
                return result
            }

            if (index < maxAttempts - 1) {
                sleeper(delaysMs.getOrElse(index) { delaysMs.lastOrNull() ?: 0L })
            }
        }

        return requireNotNull(last)
    }

    private fun isTransient(result: ApiResult<*>): Boolean {
        if (result !is ApiResult.Failure) return false
        val status = result.statusCode
        return status == 408 ||
            status == 429 ||
            (status != null && status in 500..599) ||
            result.code == "network_timeout" ||
            result.code == "network_unavailable"
    }
}
