package br.com.ia4tube.app.core.company

import br.com.ia4tube.app.data.repository.authenticatedAccountFromJwt
import java.nio.charset.StandardCharsets
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanyProfileStoreTest {
    @Test
    fun sameAccountWithDifferentFormattingKeepsItsLocalProfile() {
        assertFalse(
            shouldClearCompanyProfileForAccountChange(
                currentOwner = "Minha.Conta",
                authenticatedAccount = " minha.conta "
            )
        )
    }

    @Test
    fun differentAccountClearsThePreviousLocalProfileBeforeReuse() {
        assertTrue(
            shouldClearCompanyProfileForAccountChange(
                currentOwner = "conta-a",
                authenticatedAccount = "conta-b"
            )
        )
    }

    @Test
    fun legacyProfileIsPreservedWhenTheFirstOwnerIsBound() {
        assertFalse(
            shouldClearCompanyProfileForAccountChange(
                currentOwner = "",
                authenticatedAccount = "conta-atual"
            )
        )
    }

    @Test
    fun existingAuthenticatedSessionCanBindTheLegacyProfileToItsCurrentAccount() {
        val payload = Base64.getUrlEncoder().withoutPadding().encodeToString(
            "{\"whatsapp\":\"conta-atual\"}".toByteArray(StandardCharsets.UTF_8)
        )

        assertEquals("conta-atual", authenticatedAccountFromJwt("header.$payload.signature"))
        assertEquals("", authenticatedAccountFromJwt("token-invalido"))
    }
}
