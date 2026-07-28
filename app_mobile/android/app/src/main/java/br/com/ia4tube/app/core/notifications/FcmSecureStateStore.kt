package br.com.ia4tube.app.core.notifications

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class FcmSecureStateStore(context: Context) : FcmRegistrationStateStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE
    )

    init {
        preferences.edit().remove(LEGACY_PLAINTEXT_TOKEN_KEY).commit()
    }

    override fun load(): FcmRegistrationState {
        return synchronized(LOCK) {
            val cipherText = preferences.getString(KEY_ENCRYPTED_STATE, "").orEmpty()
            val iv = preferences.getString(KEY_STATE_IV, "").orEmpty()
            if (cipherText.isBlank() || iv.isBlank()) {
                return@synchronized FcmRegistrationState()
            }

            val json = decrypt(cipherText, iv) ?: run {
                clear()
                return@synchronized FcmRegistrationState()
            }
            runCatching {
                val root = JSONObject(json)
                if (root.optInt("version") != STATE_VERSION) {
                    return@runCatching FcmRegistrationState()
                }
                FcmRegistrationState(
                    decisionOwnerHash = root.optString("decision_owner_hash"),
                    consentGranted = root.optBoolean("consent_granted", false),
                    currentToken = root.optString("current_token"),
                    registeredOwnerHash = root.optString("registered_owner_hash"),
                    registeredToken = root.optString("registered_token")
                )
            }.getOrDefault(FcmRegistrationState())
        }
    }

    override fun save(state: FcmRegistrationState) {
        synchronized(LOCK) {
            val json = JSONObject()
                .put("version", STATE_VERSION)
                .put("decision_owner_hash", state.decisionOwnerHash)
                .put("consent_granted", state.consentGranted)
                .put("current_token", state.currentToken)
                .put("registered_owner_hash", state.registeredOwnerHash)
                .put("registered_token", state.registeredToken)
                .toString()
            val encrypted = encrypt(json)
            check(
                preferences.edit()
                    .putString(KEY_ENCRYPTED_STATE, encrypted.cipherText)
                    .putString(KEY_STATE_IV, encrypted.iv)
                    .remove(LEGACY_PLAINTEXT_TOKEN_KEY)
                    .commit()
            ) {
                "Nao foi possivel salvar o estado FCM."
            }
        }
    }

    override fun clear() {
        synchronized(LOCK) {
            preferences.edit()
                .remove(KEY_ENCRYPTED_STATE)
                .remove(KEY_STATE_IV)
                .remove(LEGACY_PLAINTEXT_TOKEN_KEY)
                .commit()
        }
    }

    private fun encrypt(value: String): EncryptedValue {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return EncryptedValue(
            cipherText = Base64.encodeToString(encrypted, Base64.NO_WRAP),
            iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        )
    }

    private fun decrypt(cipherText: String, iv: String): String? {
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateSecretKey(),
                GCMParameterSpec(
                    GCM_TAG_LENGTH_BITS,
                    Base64.decode(iv, Base64.NO_WRAP)
                )
            )
            cipher.doFinal(Base64.decode(cipherText, Base64.NO_WRAP))
                .toString(Charsets.UTF_8)
        }.getOrNull()
    }

    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE_PROVIDER
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(KEY_SIZE_BITS)
                .build()
        )
        return generator.generateKey()
    }

    private data class EncryptedValue(
        val cipherText: String,
        val iv: String
    )

    private companion object {
        const val STATE_VERSION = 1
        const val PREFERENCES_NAME = "ia4tube_fcm"
        const val KEY_ENCRYPTED_STATE = "encrypted_state"
        const val KEY_STATE_IV = "state_iv"
        const val LEGACY_PLAINTEXT_TOKEN_KEY = "last_fcm_token"
        const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val KEY_ALIAS = "ia4tube_fcm_state_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_SIZE_BITS = 256
        const val GCM_TAG_LENGTH_BITS = 128
        val LOCK = Any()
    }
}
