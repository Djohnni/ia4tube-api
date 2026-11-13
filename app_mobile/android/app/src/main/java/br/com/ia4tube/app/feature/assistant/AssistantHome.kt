package br.com.ia4tube.app.feature.assistant

import android.app.DatePickerDialog
import android.app.TimePickerDialog
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
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.ia4tube.app.R
import br.com.ia4tube.app.core.camera.CameraImageStore
import br.com.ia4tube.app.data.repository.authenticatedAccountFromJwt
import br.com.ia4tube.app.feature.home.PremiumHomePalette
import java.time.LocalDate
import java.time.format.DateTimeFormatter

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
    AssistantContent(state,palette,onPosts,onProfile,onPlans,onCalendar,
        onInput=vm::input,onSend={vm.send()},onPlan={vm.send("Quero ajuda para preparar o mês do meu Instagram.")},
        onGallery={gallery.launch(arrayOf("image/jpeg","image/png","image/webp"))},
        onCamera={val uri=CameraImageStore(context).createImageUri();cameraUri=uri.toString();camera.launch(uri)},
        onRemove=vm::remove,onReview={reviewing=true},onReport={reporting=it},onContinue=vm::continueConversation)

    if(reviewing&&state.snapshot?.draft!=null)AssistantReviewDialog(state.snapshot!!.draft!!,palette,state.busy,{reviewing=false}){items->
        vm.confirm(state.snapshot!!.draft!!,items){reviewing=false}
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
    onRemove:(String)->Unit,onReview:()->Unit,onReport:(String)->Unit,onContinue:()->Unit) {
    val typing=WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current)>0
    val scroll=rememberScrollState()
    LaunchedEffect(state.snapshot?.messages?.size,state.attachments.size,state.busy,state.error){
        if(!state.snapshot?.messages.isNullOrEmpty() || state.attachments.isNotEmpty() || state.busy || state.error!=null){
            withFrameNanos { };scroll.animateScrollTo(scroll.maxValue)
        }
    }
    Column(Modifier.fillMaxSize().border(1.dp,palette.panelBorder,RoundedCornerShape(20.dp)).padding(12.dp)
        .testTag("home_assistant"),verticalArrangement=Arrangement.spacedBy(7.dp)) {
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){
            Text("Seu assistente",color=palette.textPrimary,fontWeight=FontWeight.Bold,fontSize=20.sp,modifier=Modifier.weight(1f))
            TextButton(onClick=onPosts){Text("Posts prontos ›",color=palette.primaryBorder,fontSize=13.sp)}
        }
        val snapshot=state.snapshot
        if(state.loading)LinearProgressIndicator(Modifier.fillMaxWidth(),color=palette.primaryBorder)
        Column(Modifier.weight(1f).fillMaxWidth().testTag("assistant_messages").verticalScroll(scroll),verticalArrangement=Arrangement.spacedBy(10.dp)) {
            if(snapshot?.messages.isNullOrEmpty())AssistantBubble("Vamos preparar seus posts?",false,palette)
            snapshot?.messages?.forEach { m ->
                AssistantBubble(m.text,m.role=="user",palette)
                if(m.role=="assistant"&&m.id==snapshot.messages.lastOrNull{it.role=="assistant"}?.id)
                    TextButton(onClick={onReport(m.id)},contentPadding=PaddingValues(0.dp),modifier=Modifier.height(32.dp)){
                        Text("Sinalizar resposta",color=palette.textSecondary,fontSize=11.sp)
                    }
                if(m.photos.isNotEmpty())Text("${m.photos.size} foto(s) enviada(s)",color=palette.textSecondary,fontSize=12.sp)
            }
            if(state.busy)Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)){
                CircularProgressIndicator(Modifier.size(16.dp),strokeWidth=2.dp,color=palette.primaryBorder)
                Text("Preparando…",color=palette.textSecondary,fontSize=13.sp)
            }
        if(!typing&&snapshot?.messages.isNullOrEmpty())OutlinedButton(onClick={onPlan()},enabled=!state.busy,
            border=BorderStroke(1.dp,palette.primaryBorder),modifier=Modifier.testTag("assistant_plan_month")){
            Text("Planejar meu mês",color=palette.textPrimary)
        }
        if(!typing&&snapshot!=null&&!snapshot.hasLogo&&snapshot.messages.isEmpty())TextButton(onClick=onProfile){Text("Adicionar logo da empresa",color=palette.primaryBorder)}
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
            OutlinedButton(onClick={onReview()},enabled=!state.busy,modifier=Modifier.fillMaxWidth(),border=BorderStroke(1.dp,palette.primaryBorder)){
                Text("Revisar ${draft.items.size} publicação(ões)",color=palette.primaryBorder)
            }
        }
        snapshot?.campaigns?.lastOrNull()?.let { c ->
            val status=when(c.status){"sent"->"${c.sent} pedido(s) recebido(s). Acompanhe no calendário.";"needs_attention"->"Envio precisa de conferência: ${c.sent} de ${c.total} confirmados. Os anteriores estão preservados.";else->"Enviando seus pedidos: ${c.sent}/${c.total}"}
            Text(status,color=palette.textSecondary,fontSize=12.sp)
        }
        state.error?.let { Text(it,color=MaterialTheme.colorScheme.error,fontSize=13.sp) }
        if(state.error?.contains("Ative a publicação") == true)TextButton(onClick=onCalendar){Text("Abrir Calendário",color=palette.primaryBorder)}
        if(state.retryPending&&!state.busy)TextButton(onClick=onContinue){Text("Continuar com uma nova mensagem",color=palette.primaryBorder,fontSize=12.sp)}
        }
        Row(Modifier.fillMaxWidth().border(1.dp,palette.panelBorder,RoundedCornerShape(18.dp)).padding(4.dp).testTag("assistant_composer"),verticalAlignment=Alignment.CenterVertically){
            OutlinedTextField(value=state.input,onValueChange=onInput,placeholder={Text("Escreva sua mensagem…",fontSize=13.sp)},
                enabled=!state.busy&&!state.retryPending,modifier=Modifier.weight(1f).testTag("assistant_message"),maxLines=5,
                colors=OutlinedTextFieldDefaults.colors(focusedBorderColor=androidx.compose.ui.graphics.Color.Transparent,
                    unfocusedBorderColor=androidx.compose.ui.graphics.Color.Transparent,disabledBorderColor=androidx.compose.ui.graphics.Color.Transparent,
                    focusedPlaceholderColor=palette.textSecondary,unfocusedPlaceholderColor=palette.textSecondary,cursorColor=palette.primaryBorder,
                    focusedTextColor=palette.textPrimary,unfocusedTextColor=palette.textPrimary))
            IconButton(onClick={onGallery()},enabled=!state.busy&&!state.retryPending&&state.attachments.size<4,
                modifier=Modifier.size(44.dp).testTag("assistant_gallery")){
                Icon(painterResource(R.drawable.chat_attachment),contentDescription="Escolher fotos da galeria",tint=palette.textPrimary,modifier=Modifier.size(22.dp))
            }
            IconButton(onClick={onCamera()},
                enabled=!state.busy&&!state.retryPending&&state.attachments.size<4,modifier=Modifier.size(44.dp).testTag("assistant_camera")){
                Icon(painterResource(R.drawable.chat_camera),contentDescription="Tirar foto",tint=palette.textPrimary,modifier=Modifier.size(22.dp))
            }
            FilledIconButton(onClick={onSend()},enabled=!state.busy&&(state.input.isNotBlank()||state.attachments.isNotEmpty()||state.retryPending),
                modifier=Modifier.size(44.dp).testTag("assistant_send"),colors=IconButtonDefaults.filledIconButtonColors(containerColor=palette.primaryBorder)){
                Icon(painterResource(R.drawable.chat_send),contentDescription=if(state.retryPending)"Confirmar a mesma tentativa" else "Enviar mensagem",modifier=Modifier.size(22.dp))
            }
        }
        if(snapshot!=null)Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
            Text("${snapshot.used}/${snapshot.limit} mensagens",color=palette.textSecondary,fontSize=11.sp)
            Text("${snapshot.images} imagens · ${snapshot.videos} vídeos",color=palette.textSecondary,fontSize=11.sp)
        }
        if(snapshot!=null&&snapshot.images<=0&&snapshot.videos<=0)TextButton(onClick=onPlans){Text("Ver combos",color=palette.primaryBorder)}
        if(!typing)Text("Assistente de IA · confira as informações antes de confirmar.",fontSize=11.sp,color=palette.textSecondary)
    }
}

@Composable
private fun AssistantBubble(text:String,user:Boolean,palette:PremiumHomePalette){
    Row(Modifier.fillMaxWidth(),horizontalArrangement=if(user)Arrangement.End else Arrangement.Start){
        Text(text,color=palette.textPrimary,fontSize=15.sp,modifier=Modifier.fillMaxWidth(.94f)
            .clip(RoundedCornerShape(14.dp)).background(if(user)palette.primaryBorder.copy(alpha=.22f)else palette.panelBorder.copy(alpha=.24f)).padding(12.dp))
    }
}

@Composable
private fun AssistantReviewDialog(draft:AssistantDraft,palette:PremiumHomePalette,busy:Boolean,onDismiss:()->Unit,onConfirm:(List<AssistantItem>)->Unit){
    var items by remember(draft.id){mutableStateOf(draft.items)}
    val context=LocalContext.current
    AlertDialog(onDismissRequest={if(!busy)onDismiss()},title={Text("Confira suas publicações")},
        text={Column(Modifier.heightIn(max=460.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(14.dp)){
            Text("A criação usa seu saldo. As artes prontas irão para o calendário nas datas escolhidas.")
            items.forEachIndexed { n,item ->
                Column(verticalArrangement=Arrangement.spacedBy(5.dp)){
                    Text("${n+1}. ${item.title} · ${if(item.kind=="video")"Vídeo 10s" else "Imagem"}",fontWeight=FontWeight.Bold)
                    if(item.imageText.isNotBlank())Text("Na imagem: ${item.imageText}")
                    Text(item.caption,fontSize=13.sp)
                    Row(horizontalArrangement=Arrangement.spacedBy(5.dp)){
                        OutlinedButton(onClick={val date=runCatching{LocalDate.parse(item.date)}.getOrDefault(LocalDate.now().plusDays(1));
                            DatePickerDialog(context,{_,y,m,d->items=items.toMutableList().also{it[n]=item.copy(date=LocalDate.of(y,m+1,d).toString())}},date.year,date.monthValue-1,date.dayOfMonth).show()
                        }){Text(runCatching{LocalDate.parse(item.date).format(DateTimeFormatter.ofPattern("dd/MM/yyyy"))}.getOrDefault("Escolher dia"))}
                        OutlinedButton(onClick={val t=item.time.split(':');TimePickerDialog(context,{_,h,m->items=items.toMutableList().also{it[n]=item.copy(time="%02d:%02d".format(h,m))}},t.getOrNull(0)?.toIntOrNull()?:18,t.getOrNull(1)?.toIntOrNull()?:0,true).show()}){Text(item.time.ifBlank{"Escolher hora"})}
                    }
                    Row(verticalAlignment=Alignment.CenterVertically){
                        val feed=item.destination!="story";val story=item.destination!="feed"
                        Checkbox(feed,onCheckedChange={v->items=items.toMutableList().also{it[n]=item.copy(destination=if(v&&story)"both" else if(v)"feed" else "story")}})
                        Text(if(item.kind=="video")"Reels"else"Feed")
                        Checkbox(story,onCheckedChange={v->items=items.toMutableList().also{it[n]=item.copy(destination=if(v&&feed)"both" else if(v)"story" else "feed")}})
                        Text("Story")
                    }
                    HorizontalDivider()
                }
            }
            Text("Horário de Brasília. Confira valores, legendas e datas antes de confirmar.",fontSize=12.sp)
        }},
        confirmButton={TextButton(onClick={onConfirm(items)},enabled=!busy&&items.all{it.date.isNotBlank()&&it.time.isNotBlank()}){Text(if(busy)"Confirmando…"else"Criar e programar")}},
        dismissButton={TextButton(onClick=onDismiss,enabled=!busy){Text("Voltar")}})
}
