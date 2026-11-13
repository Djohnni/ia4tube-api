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
