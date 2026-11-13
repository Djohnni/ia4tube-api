package br.com.ia4tube.app.feature.assistant

import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
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

internal fun assistantScheduledItems(draft:AssistantDraft,selections:List<String>):List<AssistantItem> =
    draft.items.mapIndexed { index,item ->
        val parts=selections.getOrNull(index)?.split('|').orEmpty()
        if(parts.size==3)item.copy(date=parts[0],time=parts[1],destination=parts[2])else item
    }

@Composable
internal fun AssistantScheduleFlow(draft:AssistantDraft,businessType:String,busy:Boolean,error:String?,
    onDismiss:()->Unit,onConfirm:(List<AssistantItem>)->Unit){
    var index by rememberSaveable(draft.id){mutableStateOf(0)}
    var selections by rememberSaveable(draft.id){mutableStateOf(ArrayList(draft.items.map{""}))}
    if(draft.items.isEmpty())return
    val current=assistantScheduledItems(draft,selections)[index]
    key(draft.id,index){
        EditCalendarScheduleDialog(assistantScheduleInitial(current),editPostingTimeCategory(businessType),
            onDismiss={if(!busy){if(index>0)index-- else onDismiss()}},mediaKind=current.kind,
            sending=busy,statusMessage=error,
            publicationLabel=if(draft.items.size>1)"${index+1} de ${draft.items.size} · ${current.title}"else null,
            onConfirm={schedule->
                if(!busy){
                    val updated=ArrayList(selections).also{it[index]="${schedule.date}|${schedule.time}|${schedule.destination}"}
                    selections=updated
                    if(index==draft.items.lastIndex)onConfirm(assistantScheduledItems(draft,updated))else index++
                }
            })
    }
}
