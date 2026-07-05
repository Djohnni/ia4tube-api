package br.com.ia4tube.app.ui.text

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource

sealed interface UiText {
    data class Dynamic(val value: String) : UiText
    data class Resource(@StringRes val id: Int, val args: List<Any> = emptyList()) : UiText
}

fun String.toUiTextOrNull(): UiText? = if (isBlank()) null else UiText.Dynamic(this)

fun uiText(@StringRes id: Int, vararg args: Any): UiText = UiText.Resource(id, args.toList())

@Composable
fun UiText.asString(): String {
    return when (this) {
        is UiText.Dynamic -> value
        is UiText.Resource -> stringResource(id, *args.toTypedArray())
    }
}
