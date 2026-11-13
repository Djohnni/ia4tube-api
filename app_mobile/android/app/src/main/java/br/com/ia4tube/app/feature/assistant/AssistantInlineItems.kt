package br.com.ia4tube.app.feature.assistant

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.ia4tube.app.feature.home.PremiumHomePalette
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** One source photo stays attached to its own editable publication, never a positional wizard. */
@Composable
internal fun AssistantInlineItems(draft:AssistantDraft,palette:PremiumHomePalette,busy:Boolean,
    onEdit:(AssistantItem)->Unit,loadPhoto:suspend(String)->ByteArray?) {
    draft.items.forEachIndexed { index,item -> key(draft.id,item.id) {
        val context=LocalContext.current
        val bitmap by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null,item.photoId) {
            value=runCatching { loadPhoto(item.photoId)?.let { bytes ->
                BitmapFactory.decodeByteArray(bytes,0,bytes.size)?.asImageBitmap()
            } }.getOrNull()
        }
        Column(Modifier.fillMaxWidth().padding(horizontal=8.dp,vertical=5.dp)
            .testTag("assistant_item_${item.id}"),verticalArrangement=Arrangement.spacedBy(6.dp)) {
            Text("Foto ${index+1} de ${draft.items.size}",fontSize=12.sp,color=palette.textSecondary)
            Box(Modifier.fillMaxWidth().height(144.dp).clip(RoundedCornerShape(10.dp))
                .border(1.dp,palette.panelBorder,RoundedCornerShape(10.dp))) {
                bitmap?.let { Image(it,contentDescription="Foto ${index+1} da publicação",modifier=Modifier.fillMaxSize(),contentScale=ContentScale.Fit) }
                    ?: Text("Foto ${index+1}",color=palette.textSecondary,modifier=Modifier.padding(12.dp))
            }
            OutlinedTextField(item.imageText,{onEdit(item.copy(imageText=it.take(300)))},enabled=!busy,
                label={Text("Preço ou informação",fontSize=12.sp)},maxLines=2,
                modifier=Modifier.fillMaxWidth().testTag("assistant_item_text_${item.id}"),
                textStyle=LocalTextStyle.current.copy(fontSize=14.sp),
                colors=OutlinedTextFieldDefaults.colors(focusedTextColor=palette.textPrimary,unfocusedTextColor=palette.textPrimary,
                    focusedBorderColor=palette.primaryBorder,unfocusedBorderColor=palette.panelBorder,
                    focusedLabelColor=palette.primaryBorder,unfocusedLabelColor=palette.textSecondary,cursorColor=palette.primaryBorder))
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                val date=runCatching{LocalDate.parse(item.date)}.getOrNull()
                val time=runCatching{LocalTime.parse(item.time)}.getOrNull()
                val fallback=ZonedDateTime.now(ZoneId.of("America/Sao_Paulo")).plusHours(1)
                OutlinedButton(onClick={val d=date?:fallback.toLocalDate();DatePickerDialog(context,{_,y,m,day->
                    onEdit(item.copy(date=LocalDate.of(y,m+1,day).toString()))},d.year,d.monthValue-1,d.dayOfMonth).show()},
                    enabled=!busy,modifier=Modifier.weight(1.2f).heightIn(min=44.dp).testTag("assistant_item_date_${item.id}"),
                    contentPadding=PaddingValues(horizontal=6.dp),colors=ButtonDefaults.outlinedButtonColors(contentColor=palette.primaryBorder)) {
                    Text(date?.format(DateTimeFormatter.ofPattern("dd/MM/yyyy"))?:"Escolher dia",fontSize=13.sp)
                }
                OutlinedButton(onClick={val t=time?:fallback.toLocalTime();TimePickerDialog(context,{_,h,m->
                    onEdit(item.copy(time=LocalTime.of(h,m).format(DateTimeFormatter.ofPattern("HH:mm"))))},t.hour,t.minute,true).show()},
                    enabled=!busy,modifier=Modifier.weight(1f).heightIn(min=44.dp).testTag("assistant_item_time_${item.id}"),
                    contentPadding=PaddingValues(horizontal=6.dp),colors=ButtonDefaults.outlinedButtonColors(contentColor=palette.primaryBorder)) {
                    Text(time?.format(DateTimeFormatter.ofPattern("HH:mm"))?:"Horário",fontSize=13.sp)
                }
            }
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                InlineChoice(if(item.kind=="video")"Reels"else"Feed",item.destination!="story",!busy,Modifier.weight(1f)
                    .testTag("assistant_item_feed_${item.id}")) { onEdit(item.copy(destination=assistantToggleDestination(item.destination,false))) }
                InlineChoice("Story",item.destination!="feed",!busy,Modifier.weight(1f)
                    .testTag("assistant_item_story_${item.id}")) { onEdit(item.copy(destination=assistantToggleDestination(item.destination,true))) }
            }
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                InlineChoice("Imagem",item.kind=="image",!busy,Modifier.weight(1f).testTag("assistant_item_image_${item.id}")) { onEdit(item.copy(kind="image")) }
                InlineChoice("Vídeo · 10s",item.kind=="video",!busy,Modifier.weight(1f).testTag("assistant_item_video_${item.id}")) { onEdit(item.copy(kind="video")) }
            }
            if(!assistantItemReady(item))Text("Escolha dia e horário futuros · Brasília",fontSize=11.sp,color=palette.textSecondary)
        }
    } }
}

@Composable
private fun InlineChoice(label:String,selected:Boolean,enabled:Boolean,modifier:Modifier,onClick:()->Unit) {
    FilterChip(selected=selected,onClick=onClick,enabled=enabled,modifier=modifier.heightIn(min=40.dp),
        label={Text(label,fontSize=13.sp)})
}

/** A destination can never be empty; tapping the only active placement keeps it. */
internal fun assistantToggleDestination(current:String,story:Boolean):String = when {
    story&&current=="both"->"feed"
    !story&&current=="both"->"story"
    story&&current=="feed"->"both"
    !story&&current=="story"->"both"
    else->current
}

internal fun assistantItemReady(item:AssistantItem):Boolean =
    item.kind in setOf("image","video")&&item.destination in setOf("feed","story","both")&&assistantScheduleInitial(item)!=null
