package br.com.ia4tube.app.feature.assistant

import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.feature.edit.EditCalendarSchedule
import br.com.ia4tube.app.feature.edit.EditCalendarScheduleDialog
import br.com.ia4tube.app.feature.edit.editPostingTimeCategory

/** Acknowledging a proposal opens scheduling; it never sends a production request. */
internal fun assistantScheduleRequested(state:AssistantUiState):Boolean =
    !state.busy && !state.retryPending && state.attachments.isEmpty() &&
        state.snapshot?.draft?.items?.isNotEmpty()==true &&
        Regex("^(sim|confirmo|confirmar|pode fazer|pode criar|pode continuar|continuar|ok)[.!\\s]*$",RegexOption.IGNORE_CASE)
            .matches(state.input.trim())

internal fun assistantScheduleInitial(item:AssistantItem):EditCalendarSchedule? =
    EditCalendarSchedule(item.date,item.time,item.destination).takeIf{it.isFuture()}

internal fun assistantScheduledItems(draft:AssistantDraft,selections:List<String>,kinds:List<String> = draft.items.map{it.kind}):List<AssistantItem> =
    draft.items.mapIndexed { index,item ->
        val selected=item.copy(kind=kinds.getOrNull(index)?.takeIf{it in setOf("image","video")}?:item.kind)
        val parts=selections.getOrNull(index)?.split('|').orEmpty()
        if(parts.size==3)selected.copy(date=parts[0],time=parts[1],destination=parts[2])else selected
    }

@Composable
internal fun AssistantScheduleFlow(draft:AssistantDraft,businessType:String,busy:Boolean,error:String?,
    onDismiss:()->Unit,imageBalance:Int=Int.MAX_VALUE,videoBalance:Int=Int.MAX_VALUE,onConfirm:(List<AssistantItem>)->Unit){
    var index by rememberSaveable(draft.id){mutableStateOf(0)}
    var selections by rememberSaveable(draft.id){mutableStateOf(ArrayList(draft.items.map{""}))}
    var kinds by rememberSaveable(draft.id){mutableStateOf(ArrayList(draft.items.map{it.kind}))}
    if(draft.items.isEmpty())return
    val current=assistantScheduledItems(draft,selections,kinds)[index]
    val enough=kinds.count{it=="image"}<=imageBalance&&kinds.count{it=="video"}<=videoBalance
    key(draft.id,index){
        EditCalendarScheduleDialog(assistantScheduleInitial(current),editPostingTimeCategory(businessType),
            onDismiss={if(!busy){if(index>0)index-- else onDismiss()}},mediaKind=current.kind,
            sending=busy,statusMessage=error?:if(!enough)"Seu saldo não permite essa quantidade nesse formato."else null,
            confirmEnabled=enough,
            leadingContent={
              Column(verticalArrangement=Arrangement.spacedBy(4.dp)){
                Text("Receber como",style=MaterialTheme.typography.labelLarge)
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)){
                    for((kind,label) in listOf("image" to "Imagem","video" to "Vídeo · 10s"))FilterChip(
                        selected=current.kind==kind,onClick={kinds=ArrayList(kinds).also{it[index]=kind}},
                        enabled=!busy&&(if(kind=="video")videoBalance>0 else imageBalance>0),label={Text(label)})
                }
                Text(if(current.kind=="video")"Usa 1 vídeo do plano."else"Usa 1 imagem do plano.",style=MaterialTheme.typography.bodySmall)
              }
            },
            publicationLabel=if(draft.items.size>1)"${index+1} de ${draft.items.size} · ${current.title}"else null,
            onConfirm={schedule->
                if(!busy){
                    val updated=ArrayList(selections).also{it[index]="${schedule.date}|${schedule.time}|${schedule.destination}"}
                    selections=updated
                    if(index==draft.items.lastIndex)onConfirm(assistantScheduledItems(draft,updated,kinds))else index++
                }
            })
    }
}
