package br.com.ia4tube.app.core.notifications

import br.com.ia4tube.app.data.models.ApiResult
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FcmRetryPolicyTest {
    @Test
    fun retriesTransientFailuresAtMostThreeTimes() = runBlocking {
        var attempts = 0
        val policy = FcmRetryPolicy(sleeper = {})

        val result = policy.execute {
            attempts += 1
            if (attempts < 3) {
                ApiResult.Failure("synthetic", statusCode = 503)
            } else {
                ApiResult.Success(Unit)
            }
        }

        assertTrue(result is ApiResult.Success)
        assertEquals(3, attempts)
    }

    @Test
    fun doesNotRetryPermanentClientFailure() = runBlocking {
        var attempts = 0
        val policy = FcmRetryPolicy(sleeper = {})

        val result = policy.execute<Unit> {
            attempts += 1
            ApiResult.Failure("synthetic", statusCode = 403)
        }

        assertTrue(result is ApiResult.Failure)
        assertEquals(1, attempts)
    }
}
