package br.com.ia4tube.app.feature.edit

import org.junit.Assert.assertEquals
import org.junit.Test

class EditNavigationPolicyTest {
    private val page = "https://ia4tube.com/edit/#pedido-salvo"
    private val draft = "https://wa.me/554791049079?text=Pedido%3A%20abc%0AValor%3A%20R%24%2027%2C00"

    @Test fun savedOrderCanOpenExactWhatsAppAfterAsyncPostWithoutGesture() {
        assertEquals(EditNavigation.EXTERNAL, EditNavigationPolicy.decide(draft, page, true, false))
    }

    @Test fun automaticExternalNavigationCannotChangeDestinationOrOrigin() {
        for (target in listOf(
            draft.replace("554791049079", "5511999999999"),
            draft.replace("wa.me", "wa.me.evil.example"),
            draft + "&redirect=https%3A%2F%2Fevil.example",
            "https://wa.me/554791049079?text=",
            "https://wa.me/554791049079?text=%",
            "https://wa.me/554791049079?text=ok#extra"
        )) assertEquals(target, EditNavigation.BLOCK, EditNavigationPolicy.decide(target, page, true, false))
        assertEquals(EditNavigation.BLOCK, EditNavigationPolicy.decide(draft, "https://evil.example/edit/", true, true))
        assertEquals(EditNavigation.BLOCK, EditNavigationPolicy.decide(draft, "https://ia4tube.com/produtos/", true, false))
        assertEquals(EditNavigation.BLOCK, EditNavigationPolicy.decide(draft, page, false, true))
    }

    @Test fun realWebsiteRemainsInternalAndOrdinaryExternalLinksRequireClick() {
        for (url in listOf(EDIT_URL, "https://www.ia4tube.com/edit/#perfil", "https://ia4tube.com/politica-de-privacidade/")) {
            assertEquals(EditNavigation.IN_WEBVIEW, EditNavigationPolicy.decide(url, page, true, false))
        }
        val external = "https://www.instagram.com/ia4tube_empresas/"
        assertEquals(EditNavigation.BLOCK, EditNavigationPolicy.decide(external, page, true, false))
        assertEquals(EditNavigation.EXTERNAL, EditNavigationPolicy.decide(external, page, true, true))
    }

    @Test fun unsafeSchemesCredentialsAndPortsNeverNavigate() {
        for (url in listOf("file:///private/file", "content://provider/private", "javascript:alert(1)",
            "intent://wa.me/#Intent;end", "http://ia4tube.com/edit/", "https://ia4tube.com:444/edit/",
            "https://user@ia4tube.com/edit/", "https://ia4tube.com@evil.example/edit/")) {
            assertEquals(url, EditNavigation.BLOCK, EditNavigationPolicy.decide(url, page, true, false))
        }
    }
}
