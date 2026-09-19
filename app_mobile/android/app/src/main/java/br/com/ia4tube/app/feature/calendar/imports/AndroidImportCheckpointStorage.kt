package br.com.ia4tube.app.feature.calendar.imports

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keystore-only key and noBackupFilesDir: independent of login token and evictable image cache. */
fun androidImportCheckpointStore(context: Context): PrivateImportCheckpointStore = PrivateImportCheckpointStore(
    File(context.applicationContext.noBackupFilesDir.canonicalFile, "calendar_import_checkpoints_v1"), AndroidImportCheckpointCipher())

internal class AndroidImportCheckpointCipher : ImportCheckpointCipher {
    private fun secretKey(): SecretKey = synchronized(keyLock) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return@synchronized it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        generator.generateKey()
    }
    override fun encrypt(scope: String, plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        cipher.updateAAD(("calendar-import-v1:" + scope).toByteArray(Charsets.UTF_8))
        require(cipher.iv.size == 12)
        return cipher.iv + cipher.doFinal(plain)
    }
    override fun decrypt(scope: String, sealed: ByteArray): ByteArray {
        require(sealed.size >= 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
        cipher.updateAAD(("calendar-import-v1:" + scope).toByteArray(Charsets.UTF_8))
        return cipher.doFinal(sealed, 12, sealed.size - 12)
    }
    private companion object {
        const val KEY_ALIAS = "ia4tube_calendar_import_checkpoint_v1"
        val keyLock = Any()
    }
}
