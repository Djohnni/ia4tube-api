package br.com.ia4tube.app.core.company

import android.content.Context
import java.text.Normalizer
import java.util.Locale

internal fun normalizeCompanyProfileOwner(value: String): String {
    return Normalizer.normalize(value.trim(), Normalizer.Form.NFD)
        .replace("[\\u0300-\\u036f]".toRegex(), "")
        .lowercase(Locale.ROOT)
        .replace("[^a-z0-9._-]+".toRegex(), "")
}

internal fun shouldClearCompanyProfileForAccountChange(
    currentOwner: String,
    authenticatedAccount: String
): Boolean {
    val normalizedCurrent = normalizeCompanyProfileOwner(currentOwner)
    val normalizedAuthenticated = normalizeCompanyProfileOwner(authenticatedAccount)
    return normalizedCurrent.isNotBlank() &&
        normalizedAuthenticated.isNotBlank() &&
        normalizedCurrent != normalizedAuthenticated
}

class CompanyProfileStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun getProfile(): CompanyProfile {
        return CompanyProfile(
            nomeEmpresa = preferences.getString(KEY_NOME_EMPRESA, "").orEmpty(),
            ramo = preferences.getString(KEY_RAMO, "").orEmpty(),
            whatsapp = preferences.getString(KEY_WHATSAPP, "").orEmpty(),
            instagram = preferences.getString(KEY_INSTAGRAM, "").orEmpty(),
            historia = preferences.getString(KEY_HISTORIA, "").orEmpty(),
            endereco = preferences.getString(KEY_ENDERECO, "").orEmpty(),
            cidade = preferences.getString(KEY_CIDADE, "").orEmpty(),
            estado = preferences.getString(KEY_ESTADO, "").orEmpty(),
            cep = preferences.getString(KEY_CEP, "").orEmpty(),
            email = preferences.getString(KEY_EMAIL, "").orEmpty(),
            site = preferences.getString(KEY_SITE, "").orEmpty(),
            logoUri = preferences.getString(KEY_LOGO_URI, "").orEmpty()
        )
    }

    fun saveProfile(profile: CompanyProfile) {
        preferences.edit()
            .putString(KEY_NOME_EMPRESA, profile.nomeEmpresa)
            .putString(KEY_RAMO, profile.ramo)
            .putString(KEY_WHATSAPP, profile.whatsapp)
            .putString(KEY_INSTAGRAM, profile.instagram)
            .putString(KEY_HISTORIA, profile.historia)
            .putString(KEY_ENDERECO, profile.endereco)
            .putString(KEY_CIDADE, profile.cidade)
            .putString(KEY_ESTADO, profile.estado)
            .putString(KEY_CEP, profile.cep)
            .putString(KEY_EMAIL, profile.email)
            .putString(KEY_SITE, profile.site)
            .putString(KEY_LOGO_URI, profile.logoUri)
            .apply()
    }

    fun prepareForAuthenticatedAccount(accountId: String) {
        val normalizedAccount = normalizeCompanyProfileOwner(accountId)
        if (normalizedAccount.isBlank()) return

        val currentOwner = preferences.getString(KEY_PROFILE_OWNER, "").orEmpty()
        if (shouldClearCompanyProfileForAccountChange(currentOwner, normalizedAccount)) {
            preferences.edit()
                .clear()
                .putString(KEY_PROFILE_OWNER, normalizedAccount)
                .apply()
            return
        }

        if (normalizeCompanyProfileOwner(currentOwner).isBlank()) {
            preferences.edit()
                .putString(KEY_PROFILE_OWNER, normalizedAccount)
                .apply()
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "ia4tube_company_profile"
        const val KEY_NOME_EMPRESA = "nome_empresa"
        const val KEY_RAMO = "ramo"
        const val KEY_WHATSAPP = "whatsapp"
        const val KEY_INSTAGRAM = "instagram"
        const val KEY_HISTORIA = "historia"
        const val KEY_ENDERECO = "endereco"
        const val KEY_CIDADE = "cidade"
        const val KEY_ESTADO = "estado"
        const val KEY_CEP = "cep"
        const val KEY_EMAIL = "email"
        const val KEY_SITE = "site"
        const val KEY_LOGO_URI = "logo_uri"
        const val KEY_PROFILE_OWNER = "profile_owner"
    }
}
