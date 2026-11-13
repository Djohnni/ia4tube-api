package br.com.ia4tube.app.feature.assistant

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.BitmapFactory
import android.net.Uri
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.ia4tube.app.R
import br.com.ia4tube.app.core.camera.CameraImageStore
import br.com.ia4tube.app.data.repository.authenticatedAccountFromJwt
import br.com.ia4tube.app.feature.home.PremiumHomePalette
import br.com.ia4tube.app.feature.calendar.CalendarAlertDialog

@Composable
internal fun AssistantHome(palette:PremiumHomePalette,token:()->String,onPosts:()->Unit,onProfile:()->Unit,onPlans:()->Unit,onCalendar:()->Unit) {
    val context=LocalContext.current
    // Resize only while this chat is mounted; leave the previous screens' window mode intact.
    DisposableEffect(context) {
        val activity=generateSequence(context as Context){(it as? ContextWrapper)?.baseContext}
            .filterIsInstance<Activity>().firstOrNull()
        val window=activity?.window
        val previousMode=window?.attributes?.softInputMode
        if(window!=null&&previousMode!=null)window.setSoftInputMode(
            (previousMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST.inv()) or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        onDispose { if(previousMode!=null)window?.setSoftInputMode(previousMode) }
    }
    val owner=authenticatedAccountFromJwt(token())
    val vm:AssistantViewModel=viewModel(key="assistant-$owner",factory=AssistantViewModelFactory(context,token))
    val state by vm.state.collectAsState()
    var cameraUri by rememberSaveable { mutableStateOf("") }
    var reviewing by rememberSaveable { mutableStateOf(false) }
    var reporting by rememberSaveable { mutableStateOf("") }
    val camera=rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()){saved->
        if(saved&&cameraUri.isNotBlank())vm.attach(Uri.parse(cameraUri));cameraUri=""
    }
    val gallery=rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()){uris->vm.attachAll(uris.take(4-state.attachments.size))}
    val logo=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()){uri->uri?.let(vm::saveLogo)}
    AssistantContent(state,palette,onPosts,onProfile,onPlans,onCalendar,
        onInput=vm::input,onSend={if(assistantScheduleRequested(state)){vm.input("");vm.reviewRequested()}else vm.send()},onPlan={vm.send("Quero ajuda para preparar o mês do meu Instagram.")},
        onGallery={gallery.launch(arrayOf("image/jpeg","image/png","image/webp"))},
        onCamera={val uri=CameraImageStore(context).createImageUri();cameraUri=uri.toString();camera.launch(uri)},
        onRemove=vm::remove,onReview={state.snapshot?.draft?.let { draft ->
            if(state.snapshot?.hasLogo==true)vm.confirm(draft,draft.items){reviewing=false}else reviewing=true
        }},onReport={reporting=it},onContinue=vm::continueConversation,onEditItem=vm::editItem,loadPhoto=vm::photoBytes)

    if(reviewing&&state.snapshot?.draft!=null) {
        if(!state.snapshot!!.hasLogo)AssistantLogoDialog(state.busy,state.error,{reviewing=false}){
            logo.launch(arrayOf("image/jpeg","image/png","image/webp"))
        } else LaunchedEffect(Unit){reviewing=false}
    }
    if(reporting.isNotBlank())AlertDialog(onDismissRequest={reporting=""},title={Text("Sinalizar esta resposta?")},
        text={Text("Avise se esta resposta é inadequada ou contém informações perigosas. Ela será registrada para análise.")},
        confirmButton={TextButton(onClick={vm.report(reporting);reporting=""}){Text("Sinalizar")}},
        dismissButton={TextButton(onClick={reporting=""}){Text("Voltar")}})
}

@Composable
internal fun AssistantContent(state:AssistantUiState,palette:PremiumHomePalette,
    onPosts:()->Unit,onProfile:()->Unit,onPlans:()->Unit,onCalendar:()->Unit,
    onInput:(String)->Unit,onSend:()->Unit,onPlan:()->Unit,onGallery:()->Unit,onCamera:()->Unit,
    onRemove:(String)->Unit,onReview:()->Unit,onReport:(String)->Unit,onContinue:()->Unit,
    onEditItem:(AssistantItem)->Unit={},loadPhoto:suspend(String)->ByteArray?={null}) {
    val scroll=rememberScrollState()
    var draftTop by remember { mutableIntStateOf(0) }
    LaunchedEffect(state.snapshot?.messages?.size,state.snapshot?.draft?.id,state.snapshot?.campaigns?.map{it.id to it.status},state.attachments.size,state.busy,state.error){
        if(!state.snapshot?.messages.isNullOrEmpty() || state.attachments.isNotEmpty() || state.busy || state.error!=null){
            withFrameNanos { };scroll.animateScrollTo(if(state.snapshot?.draft!=null&&!state.busy)draftTop.coerceIn(0,scroll.maxValue)else scroll.maxValue)
        }
    }
    Column(Modifier.fillMaxSize()
        .testTag("home_assistant"),verticalArrangement=Arrangement.spacedBy(7.dp)) {
        val snapshot=state.snapshot
        if(state.loading)LinearProgressIndicator(Modifier.fillMaxWidth(),color=palette.primaryBorder)
        Column(Modifier.weight(1f).fillMaxWidth().testTag("assistant_messages").verticalScroll(scroll),verticalArrangement=Arrangement.spacedBy(10.dp)) {
            snapshot?.messages?.forEach { m ->
                assistantDisplayText(m,snapshot)?.let { displayed -> AssistantBubble(displayed,m.role=="user",palette,
                    onReport=if(m.role=="assistant"&&m.id==snapshot.messages.lastOrNull{it.role=="assistant"}?.id)({onReport(m.id)})else null) }
                if(m.photos.isNotEmpty())Text("${m.photos.size} foto(s) enviada(s)",color=palette.textSecondary,fontSize=12.sp)
                snapshot.campaigns.filter{it.afterMessageId==m.id}.forEach { AssistantOrderBoundary(it,palette) }
            }
            if(state.busy)Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)){
                CircularProgressIndicator(Modifier.size(16.dp),strokeWidth=2.dp,color=palette.primaryBorder)
                Text("Preparando…",color=palette.textSecondary,fontSize=13.sp)
            }
        if(state.attachments.isNotEmpty())Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
            state.attachments.forEach { p ->
                val bitmap=remember(p.file.path){BitmapFactory.decodeFile(p.file.path,BitmapFactory.Options().apply{inSampleSize=4})?.asImageBitmap()}
                Column(horizontalAlignment=Alignment.CenterHorizontally){
                    bitmap?.let { Image(it,contentDescription="Foto selecionada",modifier=Modifier.size(58.dp).clip(RoundedCornerShape(8.dp)),contentScale=ContentScale.Crop) }
                    TextButton(onClick={onRemove(p.id)},enabled=!state.busy&&!state.retryPending,contentPadding=PaddingValues(0.dp)){Text("Remover",fontSize=11.sp,color=palette.textSecondary)}
                }
            }
        }
        snapshot?.draft?.let { draft ->
            Column(Modifier.fillMaxWidth().onGloballyPositioned{draftTop=it.positionInParent().y.toInt()},verticalArrangement=Arrangement.spacedBy(8.dp)) {
            AssistantInlineItems(draft,palette,state.busy||state.retryPending,onEditItem,loadPhoto)
            val enough=draft.items.count{it.kind=="image"}<=snapshot.images&&draft.items.count{it.kind=="video"}<=snapshot.videos
            if(!enough)Text("Seu saldo não permite essa quantidade nesse formato.",color=palette.textSecondary,fontSize=12.sp)
            OutlinedButton(onClick={onReview()},enabled=!state.busy&&!state.retryPending&&enough&&draft.items.all(::assistantItemReady),modifier=Modifier.fillMaxWidth().testTag("assistant_confirm_items"),border=BorderStroke(1.dp,palette.primaryBorder)){
                Text("Continuar",color=palette.primaryBorder)
            }
            }
        }
        snapshot?.campaigns?.lastOrNull()?.takeIf { c -> c.afterMessageId.isBlank()||snapshot.messages.none{it.id==c.afterMessageId} }
            ?.let { AssistantOrderBoundary(it,palette) }
        state.error?.let { Text(it,color=MaterialTheme.colorScheme.error,fontSize=13.sp) }
        if(state.error?.contains("Ative a publicação") == true)TextButton(onClick=onCalendar){Text("Abrir Calendário",color=palette.primaryBorder)}
        if(state.retryPending&&!state.busy)TextButton(onClick=onContinue){Text("Continuar com uma nova mensagem",color=palette.primaryBorder,fontSize=12.sp)}
        }
        Row(Modifier.fillMaxWidth().padding(horizontal=4.dp,vertical=6.dp).heightIn(min=48.dp).testTag("assistant_composer"),verticalAlignment=Alignment.CenterVertically){
            Row(Modifier.weight(1f).heightIn(min=48.dp).clip(RoundedCornerShape(24.dp))
                .background(palette.cameraBackground).border(1.dp,palette.panelBorder,RoundedCornerShape(24.dp))
                .testTag("assistant_input_box"),verticalAlignment=Alignment.CenterVertically){
            BasicTextField(value=state.input,onValueChange=onInput,
                enabled=!state.busy&&!state.retryPending,modifier=Modifier.weight(1f).padding(horizontal=10.dp,vertical=12.dp).testTag("assistant_message"),maxLines=5,
                textStyle=TextStyle(color=palette.textPrimary,fontSize=16.sp),cursorBrush=SolidColor(palette.primaryBorder),
                decorationBox={inner->Box {if(state.input.isEmpty())Text("Mensagem",color=palette.textSecondary,fontSize=16.sp);inner()}})
            IconButton(onClick={onGallery()},enabled=!state.busy&&!state.retryPending&&state.attachments.size<4,
                modifier=Modifier.size(44.dp).testTag("assistant_gallery")){
                Icon(painterResource(R.drawable.chat_attachment),contentDescription="Escolher fotos da galeria",tint=palette.textPrimary,modifier=Modifier.size(22.dp))
            }
            IconButton(onClick={onCamera()},
                enabled=!state.busy&&!state.retryPending&&state.attachments.size<4,modifier=Modifier.size(44.dp).testTag("assistant_camera")){
                Icon(painterResource(R.drawable.chat_camera),contentDescription="Tirar foto",tint=palette.textPrimary,modifier=Modifier.size(22.dp))
            }
            }
            Spacer(Modifier.width(4.dp))
            FilledIconButton(onClick={onSend()},enabled=!state.busy&&(state.input.isNotBlank()||state.attachments.isNotEmpty()||state.retryPending),
                modifier=Modifier.size(44.dp).testTag("assistant_send"),colors=IconButtonDefaults.filledIconButtonColors(containerColor=palette.primaryBorder)){
                Icon(painterResource(R.drawable.chat_send),contentDescription=if(state.retryPending)"Confirmar a mesma tentativa" else "Enviar mensagem",modifier=Modifier.size(22.dp))
            }
        }
        if(snapshot!=null&&snapshot.images<=0&&snapshot.videos<=0)TextButton(onClick=onPlans){Text("Ver combos",color=palette.primaryBorder)}
    }
}

internal fun assistantDisplayText(message:AssistantMessage,snapshot:AssistantSnapshot):String? {
    if(message.role!="assistant")return message.text
    val active=snapshot.draft!=null&&message.id==snapshot.messages.lastOrNull{it.role=="assistant"}?.id
    if(active)return message.text.replace(Regex("Toque em Continuar[^\\n]*",RegexOption.IGNORE_CASE),"Confira as opções abaixo de cada foto.")
    // A historical proposal must not tell the customer to press a button that no longer exists.
    return message.text.replace(Regex("\\s*Toque em Continuar[^\\n]*",RegexOption.IGNORE_CASE),"").trim().takeIf{it.isNotBlank()}
}

@Composable
private fun AssistantOrderBoundary(campaign:AssistantCampaign,palette:PremiumHomePalette){
    val received=campaign.status=="sent"&&campaign.sent==campaign.total
    val attention=campaign.status=="needs_attention"
    val title=when{received->"Pedido recebido";attention->"Precisa de atenção";else->"Enviando pedido…"}
    val color=if(attention)MaterialTheme.colorScheme.error else palette.primaryBorder
    Column(Modifier.fillMaxWidth().padding(horizontal=8.dp,vertical=10.dp).testTag("assistant_order_${campaign.id}"),
        horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(7.dp)){
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)){
            HorizontalDivider(Modifier.weight(1f),color=color)
            Text(title,color=color,fontSize=15.sp,fontWeight=FontWeight.SemiBold)
            HorizontalDivider(Modifier.weight(1f),color=color)
        }
        Text(when{received->"Acompanhe no Calendário.";attention->"${campaign.sent} de ${campaign.total} recebidos. Os confirmados foram preservados.";else->"Confirmando recebimento: ${campaign.sent}/${campaign.total}"},
            color=palette.textSecondary,fontSize=13.sp)
    }
}

@Composable
internal fun AssistantBubble(text:String,user:Boolean,palette:PremiumHomePalette,onReport:(()->Unit)?=null){
    Row(Modifier.fillMaxWidth().padding(horizontal=8.dp),horizontalArrangement=if(user)Arrangement.End else Arrangement.Start){
        val foreground=if(user)Color(0xFF211706)else Color(0xFFF6F7F9)
        Column(Modifier.fillMaxWidth(if(user).86f else .94f)
            .clip(RoundedCornerShape(topStart=14.dp,topEnd=14.dp,bottomEnd=if(user)4.dp else 14.dp,bottomStart=if(user)14.dp else 4.dp))
            .background(if(user)Color(0xFFE6BD59)else Color(0xFF24272E)).padding(12.dp)
            .testTag(if(user)"assistant_bubble_user" else "assistant_bubble_assistant"),verticalArrangement=Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) {
                Text(if(user)"Você"else"iA4tube",color=if(user)foreground else Color(0xFFFFD76A),fontSize=11.sp,fontWeight=FontWeight.Bold,modifier=Modifier.weight(1f))
                if(onReport!=null)IconButton(onClick=onReport,modifier=Modifier.size(24.dp).testTag("assistant_report")) {
                    Icon(Icons.Default.MoreVert,contentDescription="Sinalizar resposta",tint=foreground,modifier=Modifier.size(18.dp))
                }
            }
            Text(text,color=foreground,fontSize=15.sp)
        }
    }
}

@Composable
private fun AssistantLogoDialog(busy:Boolean,error:String?,onDismiss:()->Unit,onChoose:()->Unit){
    CalendarAlertDialog(onDismissRequest={if(!busy)onDismiss()},title={Text("Logo da empresa")},
        text={Column(verticalArrangement=Arrangement.spacedBy(10.dp)){
            Text("Escolha sua logo para personalizar a arte.")
            if(busy)CircularProgressIndicator(Modifier.size(24.dp))
            if(error!=null)Text(error,color=MaterialTheme.colorScheme.error)
        }},
        confirmButton={TextButton(onClick=onChoose,enabled=!busy){Text(if(busy)"Salvando…"else"Escolher logo")}},
        dismissButton={TextButton(onClick=onDismiss,enabled=!busy){Text("Voltar")}})
}
