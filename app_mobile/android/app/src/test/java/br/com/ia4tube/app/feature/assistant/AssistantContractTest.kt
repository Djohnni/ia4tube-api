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
