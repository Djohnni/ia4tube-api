package br.com.ia4tube.app.data.models

sealed interface ApiResult<out T> {
    data class Success<T>(val value: T) : ApiResult<T>
    data class Failure(
        val message: String,
        val statusCode: Int? = null,
        val code: String = ""
    ) : ApiResult<Nothing>
}
