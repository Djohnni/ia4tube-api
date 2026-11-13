package br.com.ia4tube.app.feature.assistant

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.ia4tube.app.R
import br.com.ia4tube.app.feature.home.PremiumHomePalette

internal const val GUEST_ASSISTANT_REPLY =
    "Com a iA4tube, publicar fica muito mais fácil. Toque em Criar conta e descubra!"

/** Local visitor presentation only: no token, client, view model, upload or production request. */
@Composable
internal fun GuestAssistantHome(
    palette: PremiumHomePalette,
    onCreateAccount: () -> Unit,
    onSignIn: () -> Unit,
    onAttachmentAuthRequired: () -> Unit
) {
    val context = LocalContext.current
    DisposableEffect(context) {
        val activity = generateSequence(context as Context) { (it as? ContextWrapper)?.baseContext }
            .filterIsInstance<Activity>().firstOrNull()
        val window = activity?.window
        val previousMode = window?.attributes?.softInputMode
        if (window != null && previousMode != null) window.setSoftInputMode(
            (previousMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST.inv()) or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        )
        onDispose { if (previousMode != null) window?.setSoftInputMode(previousMode) }
    }

    // Guest text never leaves this local UI and is not forwarded after registration/login.
    var input by rememberSaveable { mutableStateOf("") }
    var messages by rememberSaveable { mutableStateOf(arrayListOf<String>()) }
    val scroll = rememberScrollState()
    LaunchedEffect(messages, scroll.maxValue) {
        if (messages.isNotEmpty()) {
            scroll.scrollTo(scroll.maxValue)
        }
    }

    Column(Modifier.fillMaxSize().testTag("home_guest_assistant"),
        verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll)
            .testTag("guest_assistant_messages"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            AssistantBubble("Olá! Quer facilitar as publicações da sua empresa?", false, palette)
            messages.forEach { text ->
                AssistantBubble(text, true, palette)
                AssistantBubble(GUEST_ASSISTANT_REPLY, false, palette)
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = onCreateAccount, modifier = Modifier.weight(1f).testTag("guest_create_account"),
                    colors = ButtonDefaults.buttonColors(containerColor = palette.primaryBorder,
                        contentColor = androidx.compose.ui.graphics.Color(0xFF211706))) {
                    Text("Criar conta")
                }
                OutlinedButton(onClick = onSignIn, modifier = Modifier.testTag("guest_sign_in"),
                    border = BorderStroke(1.dp, palette.primaryBorder)) {
                    Text("Entrar", color = palette.primaryBorder)
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp)
            .heightIn(min = 48.dp).testTag("guest_assistant_composer"), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).heightIn(min = 48.dp).clip(RoundedCornerShape(24.dp))
                .background(palette.cameraBackground).border(1.dp, palette.panelBorder, RoundedCornerShape(24.dp)),
                verticalAlignment = Alignment.CenterVertically) {
                BasicTextField(value = input, onValueChange = { input = it.take(1000) },
                    modifier = Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 12.dp)
                        .testTag("guest_assistant_message"), maxLines = 5,
                    textStyle = TextStyle(color = palette.textPrimary, fontSize = 16.sp),
                    cursorBrush = SolidColor(palette.primaryBorder),
                    decorationBox = { inner -> Box {
                        if (input.isEmpty()) Text("Mensagem", color = palette.textSecondary, fontSize = 16.sp)
                        inner()
                    } })
                IconButton(onClick = onAttachmentAuthRequired,
                    modifier = Modifier.size(44.dp).testTag("guest_assistant_gallery")) {
                    Icon(painterResource(R.drawable.chat_attachment), contentDescription = "Entrar para escolher fotos",
                        tint = palette.textPrimary, modifier = Modifier.size(22.dp))
                }
                IconButton(onClick = onAttachmentAuthRequired,
                    modifier = Modifier.size(44.dp).testTag("guest_assistant_camera")) {
                    Icon(painterResource(R.drawable.chat_camera), contentDescription = "Entrar para tirar foto",
                        tint = palette.textPrimary, modifier = Modifier.size(22.dp))
                }
            }
            Spacer(Modifier.width(4.dp))
            FilledIconButton(onClick = {
                val text = input.trim()
                if (text.isNotEmpty()) {
                    messages = ArrayList((messages + text).takeLast(3))
                    input = ""
                }
            }, enabled = input.isNotBlank(), modifier = Modifier.size(44.dp).testTag("guest_assistant_send"),
                colors = IconButtonDefaults.filledIconButtonColors(containerColor = palette.primaryBorder)) {
                Icon(painterResource(R.drawable.chat_send), contentDescription = "Enviar mensagem", modifier = Modifier.size(22.dp))
            }
        }
    }
}
