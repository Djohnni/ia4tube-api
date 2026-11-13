package br.com.ia4tube.app.feature.assistant

import android.app.Application
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
class AssistantContractTest {
    private fun draft()=AssistantDraft("draft",2,listOf(AssistantItem("item","photo","image","Oferta","Legenda completa","R$ 599,00","2099-01-17","18:00","both")))
    @Test fun shortConfirmationOpensSchedulingOnlyWhenThereIsAnUnchangedDraft() {
        val snapshot=AssistantSnapshot(emptyList(),draft(),emptyList(),10,4,true,true,1,120,false)
        val state=AssistantUiState(snapshot=snapshot,loading=false,input="Sim!")
        assertTrue(assistantScheduleRequested(state))
        assertFalse(assistantScheduleRequested(state.copy(busy=true)))
        assertFalse(assistantScheduleRequested(state.copy(retryPending=true)))
        assertFalse(assistantScheduleRequested(state.copy(input="Sim, mas mude o preço para 100")))
        assertFalse(assistantScheduleRequested(state.copy(snapshot=snapshot.copy(draft=null))))
        assertFalse(assistantScheduleRequested(state.copy(attachments=listOf(AssistantAttachment("p",java.io.File("foto.jpg"))))))
    }
    @Test fun scheduleSelectionChangesOnlyDateTimeAndPlacement() {
        val before=draft();val after=assistantScheduledItems(before,listOf("2099-02-02|17:48|story")).single()
        assertEquals(before.items.single().copy(date="2099-02-02",time="17:48",destination="story"),after)
        assertNotNull(assistantScheduleInitial(after))
        assertNull(assistantScheduleInitial(after.copy(date="",time="")))
        assertNull(assistantScheduleInitial(after.copy(date="2000-01-01")))
    }
    @Test fun choosingVideoRetainsThePhotoCaptionAndImageInformation() {
        val before=draft();val selected=assistantScheduledItems(before,listOf("2099-02-02|17:48|both"),listOf("video")).single()
        assertEquals(before.items.single().copy(kind="video",date="2099-02-02",time="17:48"),selected)
    }
    @Test fun inactiveContinueInstructionDisappearsFromTheHistoricalProposal() {
        val message=AssistantMessage("proposal","assistant","Preparei sua publicação. Toque em Continuar para escolher dia e hora.",emptyList())
        val snapshot=AssistantSnapshot(listOf(message),null,listOf(AssistantCampaign("c","sent",1,1,"proposal")),10,4,true,true,2,120,false)
        assertEquals("Preparei sua publicação.",assistantDisplayText(message,snapshot))
        assertEquals("Preparei sua publicação. Confira as opções abaixo de cada foto.",assistantDisplayText(message,snapshot.copy(draft=draft())))
    }
    @Test fun photoChoicesSurviveRestorationAndNeverMoveToAnotherItemOrRevision() {
        val original=draft().copy(items=draft().items+draft().items.single().copy(id="second",photoId="other",imageText="Outro produto"))
        val edited=original.copy(items=original.items.map{if(it.id=="second")it.copy(kind="video",imageText="R$ 49,90",time="19:02",destination="story")else it})
        val restored=assistantRestoreEdits(original,assistantSaveEdits(edited))
        assertEquals(edited,restored);assertEquals(original.items.first(),restored.items.first())
        assertEquals("other",restored.items.last().photoId)
        assertEquals(original.copy(version=3),assistantRestoreEdits(original.copy(version=3),assistantSaveEdits(edited)))
        assertEquals(original.copy(id="different"),assistantRestoreEdits(original.copy(id="different"),assistantSaveEdits(edited)))
        assertEquals(original,assistantRestoreEdits(original,assistantSaveEdits(edited).put("items",org.json.JSONArray())))
    }
    @Test fun destinationChoicesAlwaysKeepAtLeastOneAndSchedulesMustBeFuture() {
        assertEquals("feed",assistantToggleDestination("both",true));assertEquals("story",assistantToggleDestination("both",false))
        assertEquals("story",assistantToggleDestination("story",true));assertEquals("feed",assistantToggleDestination("feed",false))
        assertEquals("both",assistantToggleDestination("feed",true));assertEquals("both",assistantToggleDestination("story",false))
        assertTrue(assistantItemReady(draft().items.single()));assertFalse(assistantItemReady(draft().items.single().copy(date="")))
        assertFalse(assistantItemReady(draft().items.single().copy(date="2000-01-01")))
    }
    @Test fun preservedDraftAndCampaignAreDifferentFromACompletedPublication() {
        val state=parseAssistantSnapshot(JSONObject("""{"ok":true,"messages":[{"id":"m","role":"assistant","text":"Confira o pedido","photoIds":[]}],
            "draft":{"id":"d","version":2,"items":[{"id":"i","photoId":"p","kind":"image","title":"Oferta","caption":"Confira!","imageText":"R$ 39,90","date":null,"time":null,"destination":"both"}]},
            "campaigns":[{"id":"c","status":"needs_attention","sent":1,"total":2}],"images":10,"videos":4,"connected":true,"hasLogo":true,"messagesUsed":2,"messageLimit":60}"""))
        assertEquals("",state.draft!!.items[0].date)
        assertEquals("",state.draft.items[0].time)
        assertEquals("R$ 39,90",state.draft.items[0].imageText)
        assertEquals("both",state.draft.items[0].destination)
        assertEquals("needs_attention",state.campaigns[0].status)
        assertEquals(1,state.campaigns[0].sent)
        assertEquals(60,state.limit)
    }
    @Test fun unconfirmedResponseNeverBecomesASuccessfulChatState() {
        try { parseAssistantSnapshot(JSONObject("""{"ok":false,"code":"assistant_attempt_preserved"}"""));fail("Must refuse an unconfirmed response") }
        catch(e:AssistantException){assertEquals("assistant_unavailable",e.code)}
    }
}
